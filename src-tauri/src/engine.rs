//! Managed AI engine: a private Python environment provisioned with `uv`.
//!
//! Resona never touches a system Python. On first run it downloads a pinned,
//! checksum-verified `uv` binary, which installs a standalone CPython 3.12 and
//! the worker's dependencies into the app data directory. Removing the engine
//! deletes that directory and nothing else.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;

use crate::error::{AppError, AppResult};
use crate::paths::Paths;

pub const UV_VERSION: &str = "0.12.19";
pub const PYTHON_VERSION: &str = "3.12";

/// (target triple, archive extension, sha256) for the pinned uv release.
const UV_ASSETS: &[(&str, &str, &str)] = &[
    (
        "x86_64-pc-windows-msvc",
        "zip",
        "6dbb02d79e419522f1c500f0adb1cddcff0cda7d59b0d66ea7f5e3b4a1b2f5f0",
    ),
    (
        "aarch64-pc-windows-msvc",
        "zip",
        "115b54cb823bc48260670f5782001add6067ac8d98d18c8263a833704e287de9",
    ),
    (
        "x86_64-apple-darwin",
        "tar.gz",
        "cb5fa57bafe68fc0fb94b17f06bee0b0b9a7feb94ccbd110445afa0696e39273",
    ),
    (
        "aarch64-apple-darwin",
        "tar.gz",
        "a9a8df1eedeb192f2e47e40e2faabfb387db4b850209118786d42f89dde3e0ba",
    ),
    (
        "x86_64-unknown-linux-gnu",
        "tar.gz",
        "23bf5552d220e0842b65c862097b2ebaeba0064b74eda5e565e77fd25969d8c8",
    ),
    (
        "aarch64-unknown-linux-gnu",
        "tar.gz",
        "0804e9b164c64b6914182d5920c08551958a095986f10a3731056df701126436",
    ),
];

pub const VARIANTS: &[&str] = &["cpu", "cuda", "directml"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineManifest {
    pub variant: String,
    pub uv_version: String,
    pub python_version: String,
    pub installed_at: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineEvent {
    pub step: usize,
    pub steps: usize,
    pub title: String,
    pub line: Option<String>,
    pub done: bool,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct EngineInstaller {
    running: AtomicBool,
    cancel: Arc<Notify>,
    cancelled: AtomicBool,
}

pub fn manifest(paths: &Paths) -> Option<EngineManifest> {
    let text = std::fs::read_to_string(paths.engine.join("engine.json")).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn recommended_variant() -> &'static str {
    // CPU works everywhere (and includes Core ML on macOS). Measured on an RTX 4060:
    // DeepFilterNet3 is a small recurrent model and runs ~30x realtime on CPU, with
    // no gain from CUDA, so the 2 GB CUDA engine is opt-in (for future, larger models).
    "cpu"
}

fn target_triple() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Some("x86_64-pc-windows-msvc"),
        ("windows", "aarch64") => Some("aarch64-pc-windows-msvc"),
        ("macos", "x86_64") => Some("x86_64-apple-darwin"),
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        _ => None,
    }
}

fn uv_exe_name() -> &'static str {
    if cfg!(windows) {
        "uv.exe"
    } else {
        "uv"
    }
}

/// Detect an NVIDIA GPU cheaply (used to pre-select the CUDA variant).
pub fn has_nvidia_gpu() -> bool {
    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.arg("-L");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    cmd.output()
        .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains("GPU"))
        .unwrap_or(false)
}

impl EngineInstaller {
    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    pub fn cancel(&self) {
        if self.is_running() {
            self.cancelled.store(true, Ordering::SeqCst);
            self.cancel.notify_waiters();
        }
    }

    pub async fn install<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        paths: &Paths,
        variant: &str,
    ) -> AppResult<EngineManifest> {
        if !VARIANTS.contains(&variant) {
            return Err(AppError::msg(format!("Unknown engine variant '{variant}'")));
        }
        if self.running.swap(true, Ordering::SeqCst) {
            return Err(AppError::msg("The AI engine is already being installed."));
        }
        self.cancelled.store(false, Ordering::SeqCst);
        let res = self.install_inner(app, paths, variant).await;
        self.running.store(false, Ordering::SeqCst);
        let emit = |done: bool, error: Option<String>| {
            let _ = app.emit(
                "engine://progress",
                EngineEvent {
                    step: 4,
                    steps: 4,
                    title: "Finished".into(),
                    line: None,
                    done,
                    error,
                },
            );
        };
        match &res {
            Ok(_) => emit(true, None),
            Err(e) => emit(true, Some(e.to_string())),
        }
        res
    }

    async fn install_inner<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        paths: &Paths,
        variant: &str,
    ) -> AppResult<EngineManifest> {
        let steps = 4;
        let say = |step: usize, title: &str, line: Option<String>| {
            let _ = app.emit(
                "engine://progress",
                EngineEvent {
                    step,
                    steps,
                    title: title.into(),
                    line,
                    done: false,
                    error: None,
                },
            );
        };
        std::fs::create_dir_all(&paths.engine)?;

        say(1, "Downloading package manager (uv)", None);
        let uv = self.ensure_uv(paths).await?;
        self.check_cancel()?;

        say(2, "Installing Python runtime", None);
        let envs = uv_env(paths);
        let mut venv = Command::new(&uv);
        venv.args([
            "venv",
            "--clear",
            "--no-project",
            "--managed-python",
            "--python",
            PYTHON_VERSION,
        ])
        .arg(paths.venv());
        self.stream(venv, &envs, |l| {
            say(2, "Installing Python runtime", Some(l))
        })
        .await?;

        say(3, "Installing audio & AI libraries", None);
        let req = paths.requirements(variant);
        if !req.is_file() {
            return Err(AppError::msg(format!(
                "Missing requirements file {}",
                req.display()
            )));
        }
        let mut pip = Command::new(&uv);
        pip.args(["pip", "install", "--no-config", "--python"])
            .arg(paths.venv_python())
            .arg("-r")
            .arg(&req);
        self.stream(pip, &envs, |l| {
            say(3, "Installing audio & AI libraries", Some(l))
        })
        .await?;

        say(4, "Verifying engine", None);
        let env = crate::worker::WorkerEnv {
            python: paths.venv_python(),
            worker_dir: paths.worker.clone(),
            models_dir: paths.models.clone(),
            ffmpeg: None,
        };
        let info = crate::worker::run_simple(&env, &["info"]).await?;
        let devices = info
            .pointer("/devices/onnxDevices")
            .cloned()
            .unwrap_or_default();
        say(
            4,
            "Verifying engine",
            Some(format!("Engine OK. Compute devices: {devices}")),
        );

        let manifest = EngineManifest {
            variant: variant.into(),
            uv_version: UV_VERSION.into(),
            python_version: PYTHON_VERSION.into(),
            installed_at: now_iso(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        };
        std::fs::write(
            paths.engine.join("engine.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        // The download cache is only needed during installation.
        let _ = std::fs::remove_dir_all(paths.engine.join("cache"));
        Ok(manifest)
    }

    fn check_cancel(&self) -> AppResult<()> {
        if self.cancelled.load(Ordering::SeqCst) {
            Err(AppError::Cancelled)
        } else {
            Ok(())
        }
    }

    async fn stream(
        &self,
        mut cmd: Command,
        envs: &[(&str, PathBuf)],
        mut on_line: impl FnMut(String),
    ) -> AppResult<()> {
        self.check_cancel()?;
        crate::worker::configure(&mut cmd);
        for (k, v) in envs {
            cmd.env(k, v);
        }
        cmd.env("UV_NO_PROGRESS", "1").env("NO_COLOR", "1");
        let mut child = cmd
            .spawn()
            .map_err(|e| AppError::msg(format!("Failed to start uv: {e}")))?;
        drop(child.stdin.take());
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let tx2 = tx.clone();
        tokio::spawn(async move {
            let mut l = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = l.next_line().await {
                let _ = tx.send(line);
            }
        });
        tokio::spawn(async move {
            let mut l = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = l.next_line().await {
                let _ = tx2.send(line);
            }
        });
        let mut last = String::new();
        loop {
            tokio::select! {
                line = rx.recv() => match line {
                    Some(line) => {
                        log::info!(target: "engine", "{line}");
                        if !line.trim().is_empty() { last = line.clone(); }
                        on_line(line);
                    }
                    None => break,
                },
                _ = self.cancel.notified() => {
                    let _ = child.start_kill();
                    let _ = child.wait().await;
                    return Err(AppError::Cancelled);
                }
            }
        }
        let status = child.wait().await?;
        if !status.success() {
            return Err(AppError::msg(format!(
                "Engine setup failed ({status}): {last}"
            )));
        }
        Ok(())
    }

    async fn ensure_uv(&self, paths: &Paths) -> AppResult<PathBuf> {
        let dir = paths.engine.join("uv").join(UV_VERSION);
        let exe = dir.join(uv_exe_name());
        if exe.is_file() {
            return Ok(exe);
        }
        let triple = target_triple().ok_or_else(|| {
            AppError::msg("This platform is not supported by the managed engine.")
        })?;
        let (_, ext, sha) = UV_ASSETS
            .iter()
            .find(|(t, _, _)| *t == triple)
            .copied()
            .ok_or_else(|| AppError::msg("No uv build for this platform."))?;
        let url = format!(
            "https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/uv-{triple}.{ext}"
        );
        let dir2 = dir.clone();
        let res = tokio::task::spawn_blocking(move || download_uv(&url, ext, sha, &dir2))
            .await
            .map_err(|e| AppError::msg(e.to_string()))?;
        match res {
            Ok(()) if exe.is_file() => Ok(exe),
            Ok(()) => Err(AppError::msg(
                "uv archive did not contain the uv executable",
            )),
            Err(e) => {
                // Offline fallback: a uv already on PATH is acceptable.
                if let Some(found) = which_uv() {
                    log::warn!("uv download failed ({e}); using {}", found.display());
                    Ok(found)
                } else {
                    Err(e)
                }
            }
        }
    }
}

fn uv_env(paths: &Paths) -> Vec<(&'static str, PathBuf)> {
    vec![
        ("UV_PYTHON_INSTALL_DIR", paths.engine.join("python")),
        ("UV_CACHE_DIR", paths.engine.join("cache")),
        ("UV_TOOL_DIR", paths.engine.join("tools")),
    ]
}

fn which_uv() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|d| d.join(uv_exe_name()))
        .find(|p| p.is_file())
}

fn download_uv(url: &str, ext: &str, sha: &str, dir: &Path) -> AppResult<()> {
    log::info!("Downloading {url}");
    let resp = ureq::AgentBuilder::new()
        .timeout_connect(std::time::Duration::from_secs(30))
        .build()
        .get(url)
        .set("User-Agent", concat!("Resona/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| AppError::msg(format!("Download failed: {e}")))?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(200 * 1024 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| AppError::msg(format!("Download failed: {e}")))?;
    let digest = hex(&Sha256::digest(&bytes));
    if digest != sha {
        return Err(AppError::msg(format!(
            "uv checksum mismatch (expected {sha}, got {digest})"
        )));
    }
    std::fs::create_dir_all(dir)?;
    extract_uv(&bytes, ext, dir)
}

/// Extract only the `uv` executable from the archive (no path traversal possible).
pub fn extract_uv(bytes: &[u8], ext: &str, dir: &Path) -> AppResult<()> {
    let target = dir.join(uv_exe_name());
    let tmp = dir.join(format!("{}.part", uv_exe_name()));
    let mut found = false;
    if ext == "zip" {
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
            .map_err(|e| AppError::msg(e.to_string()))?;
        for i in 0..zip.len() {
            let mut f = zip.by_index(i).map_err(|e| AppError::msg(e.to_string()))?;
            let name = f.name().rsplit('/').next().unwrap_or("").to_string();
            if name == uv_exe_name() {
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut f, &mut out)?;
                found = true;
                break;
            }
        }
    } else {
        let gz = flate2::read::GzDecoder::new(std::io::Cursor::new(bytes));
        let mut ar = tar::Archive::new(gz);
        for entry in ar.entries()? {
            let mut entry = entry?;
            let path = entry.path()?.into_owned();
            if path.file_name().and_then(|n| n.to_str()) == Some(uv_exe_name()) {
                let mut out = std::fs::File::create(&tmp)?;
                std::io::copy(&mut entry, &mut out)?;
                found = true;
                break;
            }
        }
    }
    if !found {
        return Err(AppError::msg("uv executable not found in archive"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
    }
    std::fs::rename(&tmp, &target)?;
    Ok(())
}

pub fn remove(paths: &Paths) -> AppResult<()> {
    if paths.engine.exists() {
        std::fs::remove_dir_all(&paths.engine)?;
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn now_iso() -> String {
    // Seconds since epoch rendered as RFC 3339 (UTC) without extra dependencies.
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if mo <= 2 { y + 1 } else { y };
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{m:02}:{s:02}Z")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_target_has_a_pinned_checksum() {
        for (t, ext, sha) in UV_ASSETS {
            assert_eq!(sha.len(), 64, "{t}");
            assert!(*ext == "zip" || *ext == "tar.gz");
        }
        if let Some(t) = target_triple() {
            assert!(UV_ASSETS.iter().any(|(x, _, _)| *x == t));
        }
    }

    #[test]
    fn extracts_only_the_executable_from_tarballs() {
        let dir = tempfile::tempdir().unwrap();
        let mut buf = Vec::new();
        {
            let gz = flate2::write::GzEncoder::new(&mut buf, flate2::Compression::fast());
            let mut ar = tar::Builder::new(gz);
            for (name, data) in [
                ("uv-x/uvx", &b"other"[..]),
                ("uv-x/uv", &b"binary"[..]),
                ("uv-x/uv.exe", &b"binary"[..]),
            ] {
                let mut h = tar::Header::new_gnu();
                h.set_size(data.len() as u64);
                h.set_mode(0o644);
                h.set_cksum();
                ar.append_data(&mut h, name, data).unwrap();
            }
            ar.into_inner().unwrap().finish().unwrap();
        }
        extract_uv(&buf, "tar.gz", dir.path()).unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(uv_exe_name())).unwrap(),
            b"binary"
        );
        assert!(!dir.path().join("uvx").exists());
    }

    #[test]
    fn iso_timestamp_shape() {
        let t = now_iso();
        assert_eq!(t.len(), 20);
        assert!(t.ends_with('Z') && t.starts_with("20"));
    }
}
