use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

use crate::error::AppResult;

/// Filesystem locations used by Resona. Everything lives in per-user
/// application directories; nothing is written next to the executable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Paths {
    pub app_data: PathBuf,
    pub config: PathBuf,
    pub cache: PathBuf,
    pub logs: PathBuf,
    pub models: PathBuf,
    pub engine: PathBuf,
    pub previews: PathBuf,
    /// Directory that contains the `resona_worker` Python package.
    pub worker: PathBuf,
}

impl Paths {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> AppResult<Self> {
        let p = app.path();
        // RESONA_DATA_DIR keeps everything in one folder (portable installs, tests).
        let (app_data, config, cache, logs) = match std::env::var_os("RESONA_DATA_DIR") {
            Some(dir) => {
                let d = PathBuf::from(dir);
                (d.clone(), d.join("config"), d.join("cache"), d.join("logs"))
            }
            None => (
                p.app_data_dir()?,
                p.app_config_dir()?,
                p.app_cache_dir()?,
                p.app_log_dir()?,
            ),
        };
        let paths = Paths {
            models: app_data.join("models"),
            engine: app_data.join("engine"),
            previews: cache.join("previews"),
            worker: worker_dir(app),
            app_data,
            config,
            cache,
            logs,
        };
        for dir in [
            &paths.app_data,
            &paths.config,
            &paths.cache,
            &paths.models,
            &paths.previews,
        ] {
            std::fs::create_dir_all(dir)?;
        }
        Ok(paths)
    }

    pub fn venv(&self) -> PathBuf {
        self.engine.join("venv")
    }

    pub fn venv_python(&self) -> PathBuf {
        venv_python(&self.venv())
    }

    pub fn requirements(&self, variant: &str) -> PathBuf {
        self.worker
            .join("requirements")
            .join(format!("{variant}.txt"))
    }
}

pub fn venv_python(venv: &Path) -> PathBuf {
    if cfg!(windows) {
        venv.join("Scripts").join("python.exe")
    } else {
        venv.join("bin").join("python3")
    }
}

/// In development the worker is used straight from the repository; in a
/// bundle it ships as a Tauri resource.
fn worker_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    if let Ok(dir) = std::env::var("RESONA_WORKER_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("worker");
        if dev.join("resona_worker").is_dir() {
            return strip_verbatim(dev.canonicalize().unwrap_or(dev));
        }
    }
    app.path()
        .resource_dir()
        .map(|r| strip_verbatim(r.join("worker")))
        .unwrap_or_else(|_| PathBuf::from("worker"))
}

/// Windows verbatim-path prefix (two backslashes, '?', backslash).
const VERBATIM: &str = concat!('\\', '\\', '?', '\\');

/// `canonicalize` on Windows yields a verbatim path (`<prefix>C:\...`);
/// Python and users prefer plain paths.
pub fn strip_verbatim(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    match s.strip_prefix(VERBATIM) {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => p,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_windows_verbatim_prefix() {
        let verbatim = format!("{VERBATIM}C:{}x", '\\');
        assert_eq!(
            strip_verbatim(PathBuf::from(verbatim)),
            PathBuf::from(format!("C:{}x", '\\'))
        );
        assert_eq!(
            strip_verbatim(PathBuf::from("/usr/share/resona")),
            PathBuf::from("/usr/share/resona")
        );
    }
}
