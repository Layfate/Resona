//! Spawning the Python worker and decoding its JSON-lines protocol.
//!
//! Every operation runs in its own short-lived process. This keeps the UI
//! process free of heavy native libraries, makes cancellation a simple
//! `kill`, and guarantees that all CPU/GPU memory is released when a job ends.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::paths::Paths;
use crate::settings::Settings;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// One message from the worker's stdout.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum WorkerMsg {
    Progress {
        stage: String,
        progress: f64,
        #[serde(default)]
        message: String,
    },
    Log {
        level: String,
        message: String,
    },
    Result {
        data: Value,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonLocation {
    pub path: PathBuf,
    /// "settings" | "engine" | "dev"
    pub source: &'static str,
}

/// Locate the interpreter: user override → managed engine → developer venv.
pub fn resolve_python(paths: &Paths, settings: &Settings) -> Option<PythonLocation> {
    if let Some(p) = settings.python_path.as_deref() {
        let p = PathBuf::from(p);
        if p.is_file() {
            return Some(PythonLocation {
                path: p,
                source: "settings",
            });
        }
        log::warn!(
            "Configured Python interpreter {} does not exist",
            p.display()
        );
    }
    let engine = paths.venv_python();
    if engine.is_file() {
        return Some(PythonLocation {
            path: engine,
            source: "engine",
        });
    }
    if cfg!(debug_assertions) {
        if let Ok(p) = std::env::var("RESONA_PYTHON") {
            return Some(PythonLocation {
                path: PathBuf::from(p),
                source: "dev",
            });
        }
        let dev = crate::paths::venv_python(&paths.worker.join(".venv"));
        let dev_alt = paths.worker.join(".venv").join("bin").join("python");
        for candidate in [dev, dev_alt] {
            if candidate.is_file() {
                return Some(PythonLocation {
                    path: candidate,
                    source: "dev",
                });
            }
        }
    }
    None
}

#[derive(Debug, Clone)]
pub struct WorkerEnv {
    pub python: PathBuf,
    pub worker_dir: PathBuf,
    pub models_dir: PathBuf,
    pub ffmpeg: Option<String>,
}

impl WorkerEnv {
    pub fn new(paths: &Paths, settings: &Settings) -> AppResult<Self> {
        let python = resolve_python(paths, settings).ok_or(AppError::EngineMissing)?;
        Ok(WorkerEnv {
            python: python.path,
            worker_dir: paths.worker.clone(),
            models_dir: paths.models.clone(),
            ffmpeg: settings.ffmpeg_path.clone(),
        })
    }

    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<std::ffi::OsStr>,
    {
        let mut cmd = Command::new(&self.python);
        cmd.arg("-u")
            .arg("-X")
            .arg("utf8")
            .arg("-m")
            .arg("resona_worker");
        cmd.arg("--models-dir").arg(&self.models_dir);
        if let Some(ff) = &self.ffmpeg {
            cmd.arg("--ffmpeg").arg(ff);
        }
        cmd.args(args);
        configure(&mut cmd);
        cmd.env("PYTHONPATH", &self.worker_dir)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONNOUSERSITE", "1")
            // Never write .pyc files into the (possibly read-only) install folder.
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env_remove("PYTHONHOME")
            .current_dir(&self.worker_dir);
        cmd
    }
}

/// Common process settings: piped stdio, no console window, killed on drop.
pub fn configure(cmd: &mut Command) {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
}

/// Run a worker command to completion, forwarding every message to `on_msg`.
///
/// Returns the `result` payload, the worker's `error`, or `Cancelled` when
/// `cancel` is notified (the process is killed immediately).
pub async fn run(
    mut cmd: Command,
    stdin: Option<String>,
    cancel: Option<Arc<Notify>>,
    mut on_msg: impl FnMut(&WorkerMsg) + Send,
) -> AppResult<Value> {
    let mut child = cmd
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start the AI engine: {e}")))?;
    if let Some(mut pipe) = child.stdin.take() {
        if let Some(input) = stdin {
            pipe.write_all(input.as_bytes()).await?;
        }
        drop(pipe);
    }
    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    // Keep the tail of stderr for diagnostics when the worker crashes.
    let stderr_task = tokio::spawn(async move {
        let mut tail: VecDeque<String> = VecDeque::with_capacity(40);
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log::debug!(target: "worker", "{line}");
            if tail.len() == 40 {
                tail.pop_front();
            }
            tail.push_back(line);
        }
        tail.into_iter().collect::<Vec<_>>().join("\n")
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut outcome: Option<Result<Value, AppError>> = None;
    let cancel = cancel.unwrap_or_else(|| Arc::new(Notify::new()));
    loop {
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let line = line.trim();
                        if line.is_empty() { continue; }
                        match serde_json::from_str::<WorkerMsg>(line) {
                            Ok(msg) => {
                                match &msg {
                                    WorkerMsg::Result { data } => outcome = Some(Ok(data.clone())),
                                    WorkerMsg::Error { code, message } => {
                                        outcome = Some(Err(AppError::Worker { code: code.clone(), message: message.clone() }))
                                    }
                                    WorkerMsg::Log { level, message } => match level.as_str() {
                                        "warn" | "warning" => log::warn!(target: "worker", "{message}"),
                                        "error" => log::error!(target: "worker", "{message}"),
                                        _ => log::info!(target: "worker", "{message}"),
                                    },
                                    WorkerMsg::Progress { .. } => {}
                                }
                                on_msg(&msg);
                            }
                            Err(_) => log::debug!(target: "worker", "non-protocol output: {line}"),
                        }
                    }
                    Ok(None) | Err(_) => break,
                }
            }
            _ = cancel.notified() => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                stderr_task.abort();
                return Err(AppError::Cancelled);
            }
        }
    }
    let status = child.wait().await?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    match outcome {
        Some(res) => res,
        None => {
            let detail = stderr_tail
                .lines()
                .last()
                .unwrap_or("no output")
                .to_string();
            log::error!("Worker exited with {status} without a result:\n{stderr_tail}");
            Err(AppError::Worker {
                code: "crashed".into(),
                message: format!("The AI engine stopped unexpectedly ({status}): {detail}"),
            })
        }
    }
}

/// Convenience: run a worker command without streaming.
pub async fn run_simple(env: &WorkerEnv, args: &[&str]) -> AppResult<Value> {
    run(env.command(args), None, None, |_| {}).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_messages() {
        let m: WorkerMsg = serde_json::from_str(
            r#"{"type":"progress","stage":"process","progress":0.5,"message":"x"}"#,
        )
        .unwrap();
        assert!(matches!(m, WorkerMsg::Progress { progress, .. } if (progress - 0.5).abs() < 1e-9));
        let m: WorkerMsg =
            serde_json::from_str(r#"{"type":"error","code":"not_found","message":"nope"}"#)
                .unwrap();
        assert!(matches!(m, WorkerMsg::Error { ref code, .. } if code == "not_found"));
        let m: WorkerMsg = serde_json::from_str(r#"{"type":"result","data":{"a":1}}"#).unwrap();
        assert!(matches!(m, WorkerMsg::Result { .. }));
        assert!(serde_json::from_str::<WorkerMsg>(r#"{"type":"weird"}"#).is_err());
    }
}
