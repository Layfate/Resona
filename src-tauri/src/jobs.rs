//! Batch job queue.
//!
//! Jobs are executed by a scheduler task with a configurable concurrency limit
//! (one by default, which is the right choice for a single GPU). Each job runs
//! in its own worker process; cancelling a job kills that process and removes
//! any partially written temporary file.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Runtime};
use tokio::sync::Notify;

use crate::error::AppError;
use crate::worker::{self, WorkerEnv, WorkerMsg};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            JobStatus::Done | JobStatus::Failed | JobStatus::Cancelled
        )
    }
}

/// What the frontend submits.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobRequest {
    pub input: String,
    pub output_dir: String,
    /// Output file stem without extension (defaults to `<input stem><suffix>`).
    pub output_stem: Option<String>,
    /// Worker job spec (preset, stages, format, loudness, …). `input`/`output` are filled in here.
    pub spec: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub input: String,
    pub output: String,
    pub status: JobStatus,
    pub progress: f64,
    pub stage: String,
    pub message: String,
    pub error: Option<JobError>,
    pub result: Option<Value>,
    pub spec: Value,
    pub created_at: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
}

#[derive(Default)]
struct State {
    jobs: Vec<Job>,
    cancels: HashMap<String, Arc<Notify>>,
    running: HashSet<String>,
}

pub struct JobManager {
    state: Mutex<State>,
    wake: Notify,
    concurrency: Mutex<usize>,
}

impl Default for JobManager {
    fn default() -> Self {
        JobManager {
            state: Mutex::new(State::default()),
            wake: Notify::new(),
            concurrency: Mutex::new(1),
        }
    }
}

/// Supplies a fresh worker environment for each job (settings may change).
pub type EnvProvider = Arc<dyn Fn() -> Result<WorkerEnv, AppError> + Send + Sync>;

impl JobManager {
    pub fn set_concurrency(&self, n: usize) {
        *self.concurrency.lock().unwrap() = n.clamp(1, 4);
        self.wake.notify_one();
    }

    pub fn list(&self) -> Vec<Job> {
        self.state.lock().unwrap().jobs.clone()
    }

    pub fn enqueue<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        requests: Vec<JobRequest>,
        suffix: &str,
        overwrite: bool,
    ) -> Vec<Job> {
        let mut st = self.state.lock().unwrap();
        let mut reserved: HashSet<PathBuf> = st
            .jobs
            .iter()
            .filter(|j| !j.status.is_finished())
            .map(|j| PathBuf::from(&j.output))
            .collect();
        let mut created = Vec::new();
        for req in requests {
            let input = PathBuf::from(&req.input);
            let stem = req.output_stem.clone().unwrap_or_else(|| {
                format!(
                    "{}{}",
                    input
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("audio"),
                    suffix
                )
            });
            let format = req
                .spec
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("flac");
            let output = unique_output(
                Path::new(&req.output_dir),
                &stem,
                extension_for(format),
                &input,
                overwrite,
                &reserved,
            );
            reserved.insert(output.clone());
            let mut spec = req.spec.clone();
            if let Some(obj) = spec.as_object_mut() {
                obj.insert("input".into(), Value::String(req.input.clone()));
                obj.insert(
                    "output".into(),
                    Value::String(output.to_string_lossy().into_owned()),
                );
            }
            let job = Job {
                id: uuid::Uuid::new_v4().to_string(),
                input: req.input,
                output: output.to_string_lossy().into_owned(),
                status: JobStatus::Queued,
                progress: 0.0,
                stage: "queued".into(),
                message: "Waiting".into(),
                error: None,
                result: None,
                spec,
                created_at: crate::engine::now_iso(),
                started_at: None,
                finished_at: None,
            };
            let _ = app.emit("jobs://update", &job);
            st.jobs.push(job.clone());
            created.push(job);
        }
        drop(st);
        self.wake.notify_one();
        created
    }

    pub fn cancel<R: Runtime>(&self, app: &AppHandle<R>, id: &str) -> bool {
        let mut st = self.state.lock().unwrap();
        if let Some(n) = st.cancels.get(id) {
            n.notify_one();
            return true;
        }
        if let Some(job) = st
            .jobs
            .iter_mut()
            .find(|j| j.id == id && j.status == JobStatus::Queued)
        {
            job.status = JobStatus::Cancelled;
            job.message = "Cancelled".into();
            job.finished_at = Some(crate::engine::now_iso());
            let _ = app.emit("jobs://update", &*job);
            return true;
        }
        false
    }

    pub fn cancel_all<R: Runtime>(&self, app: &AppHandle<R>) {
        let ids: Vec<String> = self
            .list()
            .into_iter()
            .filter(|j| !j.status.is_finished())
            .map(|j| j.id)
            .collect();
        for id in ids {
            self.cancel(app, &id);
        }
    }

    /// Remove finished jobs (or one specific finished job) from the list.
    pub fn clear(&self, id: Option<&str>) {
        let mut st = self.state.lock().unwrap();
        st.jobs
            .retain(|j| !j.status.is_finished() || id.is_some_and(|i| i != j.id));
    }

    fn update<R: Runtime>(&self, app: &AppHandle<R>, id: &str, f: impl FnOnce(&mut Job)) {
        let mut st = self.state.lock().unwrap();
        if let Some(job) = st.jobs.iter_mut().find(|j| j.id == id) {
            f(job);
            let _ = app.emit("jobs://update", &*job);
        }
    }

    /// Scheduler loop; spawn once at startup.
    pub async fn run_scheduler<R: Runtime>(self: Arc<Self>, app: AppHandle<R>, env: EnvProvider) {
        loop {
            loop {
                let next = {
                    let mut st = self.state.lock().unwrap();
                    let limit = *self.concurrency.lock().unwrap();
                    if st.running.len() >= limit {
                        None
                    } else if let Some(job) =
                        st.jobs.iter_mut().find(|j| j.status == JobStatus::Queued)
                    {
                        job.status = JobStatus::Running;
                        job.stage = "starting".into();
                        job.message = "Starting AI engine".into();
                        job.started_at = Some(crate::engine::now_iso());
                        let job = job.clone();
                        let cancel = Arc::new(Notify::new());
                        st.cancels.insert(job.id.clone(), cancel.clone());
                        st.running.insert(job.id.clone());
                        Some((job, cancel))
                    } else {
                        None
                    }
                };
                let Some((job, cancel)) = next else { break };
                let _ = app.emit("jobs://update", &job);
                let me = self.clone();
                let app2 = app.clone();
                let env2 = env.clone();
                tokio::spawn(async move {
                    me.execute(&app2, job, cancel, env2).await;
                });
            }
            self.wake.notified().await;
        }
    }

    async fn execute<R: Runtime>(
        self: Arc<Self>,
        app: &AppHandle<R>,
        job: Job,
        cancel: Arc<Notify>,
        env: EnvProvider,
    ) {
        let id = job.id.clone();
        let outcome = match env() {
            Err(e) => Err(e),
            Ok(env) => {
                let stdin = serde_json::to_string(&job.spec).unwrap_or_default();
                let me = self.clone();
                let app2 = app.clone();
                let id2 = id.clone();
                worker::run(
                    env.command(["process", "--job", "-"]),
                    Some(stdin),
                    Some(cancel),
                    move |msg| {
                        if let WorkerMsg::Progress {
                            stage,
                            progress,
                            message,
                        } = msg
                        {
                            me.update(&app2, &id2, |j| {
                                j.stage = stage.clone();
                                j.progress = *progress;
                                j.message = message.clone();
                            });
                        }
                    },
                )
                .await
            }
        };
        let finished = crate::engine::now_iso();
        match outcome {
            Ok(result) => self.update(app, &id, |j| {
                j.status = JobStatus::Done;
                j.progress = 1.0;
                j.stage = "done".into();
                j.message = "Done".into();
                if let Some(out) = result.get("output").and_then(|v| v.as_str()) {
                    j.output = out.to_string();
                }
                j.result = Some(result);
                j.finished_at = Some(finished);
            }),
            Err(AppError::Cancelled) => {
                remove_temp_files(Path::new(&job.output));
                self.update(app, &id, |j| {
                    j.status = JobStatus::Cancelled;
                    j.message = "Cancelled".into();
                    j.finished_at = Some(finished);
                })
            }
            Err(e) => {
                remove_temp_files(Path::new(&job.output));
                log::error!("Job {id} failed: {e}");
                self.update(app, &id, |j| {
                    j.status = JobStatus::Failed;
                    j.message = e.to_string();
                    j.error = Some(JobError {
                        code: e.code().to_string(),
                        message: e.to_string(),
                    });
                    j.finished_at = Some(finished);
                })
            }
        }
        {
            let mut st = self.state.lock().unwrap();
            st.cancels.remove(&id);
            st.running.remove(&id);
        }
        self.wake.notify_one();
    }
}

/// File extension for an export format id.
pub fn extension_for(format: &str) -> &'static str {
    match format {
        "wav" => "wav",
        "aiff" => "aiff",
        "mp3" => "mp3",
        "ogg" => "ogg",
        "opus" => "opus",
        "m4a" | "alac" => "m4a",
        _ => "flac",
    }
}

/// `<dir>/<stem>.<ext>`, or `<stem> (2).<ext>` … if taken (unless `overwrite`).
/// Never returns the input path itself.
pub fn unique_output(
    dir: &Path,
    stem: &str,
    ext: &str,
    input: &Path,
    overwrite: bool,
    reserved: &HashSet<PathBuf>,
) -> PathBuf {
    let ext = ext.trim_start_matches('.');
    let same_as_input = |p: &Path| {
        p == input
            || (p.exists() && input.exists() && p.canonicalize().ok() == input.canonicalize().ok())
    };
    let first = dir.join(format!("{stem}.{ext}"));
    if !reserved.contains(&first) && !same_as_input(&first) && (overwrite || !first.exists()) {
        return first;
    }
    for i in 2.. {
        let p = dir.join(format!("{stem} ({i}).{ext}"));
        if !reserved.contains(&p) && !same_as_input(&p) && !p.exists() {
            return p;
        }
    }
    unreachable!()
}

/// Remove `.<stem>.resona-XXXX.tmp.<ext>` files the worker may have left.
fn remove_temp_files(output: &Path) {
    let (Some(dir), Some(stem)) = (output.parent(), output.file_stem().and_then(|s| s.to_str()))
    else {
        return;
    };
    let prefix = format!(".{stem}.resona-");
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with(&prefix) && name.contains(".tmp") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_names_skip_existing_reserved_and_input() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("song.flac");
        std::fs::write(&input, b"x").unwrap();
        let mut reserved = HashSet::new();
        // Same name as input is never used, even with overwrite.
        let p = unique_output(dir.path(), "song", "flac", &input, true, &reserved);
        assert_eq!(p, dir.path().join("song (2).flac"));
        let p1 = unique_output(dir.path(), "song_resona", "flac", &input, false, &reserved);
        assert_eq!(p1, dir.path().join("song_resona.flac"));
        reserved.insert(p1.clone());
        let p2 = unique_output(dir.path(), "song_resona", "flac", &input, false, &reserved);
        assert_eq!(p2, dir.path().join("song_resona (2).flac"));
        std::fs::write(&p1, b"y").unwrap();
        reserved.clear();
        assert_eq!(
            unique_output(dir.path(), "song_resona", "flac", &input, false, &reserved),
            p2
        );
        assert_eq!(
            unique_output(dir.path(), "song_resona", "flac", &input, true, &reserved),
            p1
        );
    }

    #[test]
    fn temp_files_are_cleaned() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("a_resona.flac");
        let tmp = dir.path().join(".a_resona.resona-1234abcd.tmp.flac");
        let keep = dir.path().join("other.flac");
        std::fs::write(&tmp, b"x").unwrap();
        std::fs::write(&keep, b"x").unwrap();
        remove_temp_files(&out);
        assert!(!tmp.exists() && keep.exists());
    }
}
