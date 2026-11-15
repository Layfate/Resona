//! Tauri commands invoked from the frontend.

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::engine::{self, EngineManifest};
use crate::error::{AppError, AppResult};
use crate::jobs::{Job, JobRequest};
use crate::settings::Settings;
use crate::worker::{self, PythonLocation, WorkerEnv, WorkerMsg};
use crate::AppState;

/// Extensions offered in the file picker and accepted on drop / folder scan.
pub const AUDIO_EXTENSIONS: &[&str] = &[
    "wav", "flac", "mp3", "ogg", "oga", "opus", "m4a", "aac", "aif", "aiff", "wma", "alac", "caf",
    "w64", "webm",
];

/// Formats every supported web view decodes natively (others get a WAV preview).
const PLAYABLE: &[&str] = &["wav", "mp3", "flac", "m4a", "aac"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    platform: String,
    arch: String,
    paths: crate::paths::Paths,
    python: Option<PythonLocation>,
    engine: Option<EngineManifest>,
    engine_installing: bool,
    nvidia_gpu: bool,
    variants: Vec<&'static str>,
    recommended_variant: &'static str,
    audio_extensions: Vec<&'static str>,
}

fn env_for(state: &AppState) -> AppResult<WorkerEnv> {
    let settings = state.settings.read().unwrap().clone();
    WorkerEnv::new(&state.paths, &settings)
}

fn allow(app: &AppHandle, path: &Path) {
    if let Err(e) = app.asset_protocol_scope().allow_file(path) {
        log::warn!("Could not allow {} for playback: {e}", path.display());
    }
}

#[tauri::command]
pub fn app_info(state: State<'_, AppState>) -> AppInfo {
    let settings = state.settings.read().unwrap().clone();
    let nvidia = *state.nvidia.get_or_init(engine::has_nvidia_gpu);
    let recommended = engine::recommended_variant();
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        platform: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        paths: state.paths.clone(),
        python: worker::resolve_python(&state.paths, &settings),
        engine: engine::manifest(&state.paths),
        engine_installing: state.installer.is_running(),
        nvidia_gpu: nvidia,
        variants: engine::VARIANTS.to_vec(),
        recommended_variant: recommended,
        audio_extensions: AUDIO_EXTENSIONS.to_vec(),
    }
}

/// Environment report from the worker (devices, FFmpeg, models). Cached.
#[tauri::command]
pub async fn engine_info(state: State<'_, AppState>, refresh: Option<bool>) -> AppResult<Value> {
    if !refresh.unwrap_or(false) {
        if let Some(v) = state.info_cache.lock().unwrap().clone() {
            return Ok(v);
        }
    }
    let env = env_for(&state)?;
    let info = worker::run_simple(&env, &["info"]).await?;
    *state.info_cache.lock().unwrap() = Some(info.clone());
    Ok(info)
}

#[tauri::command]
pub async fn install_engine(
    app: AppHandle,
    state: State<'_, AppState>,
    variant: String,
) -> AppResult<EngineManifest> {
    let res = state.installer.install(&app, &state.paths, &variant).await;
    *state.info_cache.lock().unwrap() = None;
    res
}

#[tauri::command]
pub fn cancel_engine_install(state: State<'_, AppState>) {
    state.installer.cancel();
}

#[tauri::command]
pub fn remove_engine(state: State<'_, AppState>) -> AppResult<()> {
    if state.installer.is_running() {
        return Err(AppError::msg("Wait for the installation to finish first."));
    }
    *state.info_cache.lock().unwrap() = None;
    engine::remove(&state.paths)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings.read().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> AppResult<Settings> {
    let settings = settings.sanitized();
    settings.save(&state.paths.config)?;
    let changed_env = {
        let old = state.settings.read().unwrap();
        old.python_path != settings.python_path || old.ffmpeg_path != settings.ffmpeg_path
    };
    state.jobs.set_concurrency(settings.concurrency as usize);
    *state.settings.write().unwrap() = settings.clone();
    if changed_env {
        *state.info_cache.lock().unwrap() = None;
    }
    Ok(settings)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    id: String,
    progress: f64,
}

/// `action`: list | install | verify | remove
#[tauri::command]
pub async fn model_action(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    id: Option<String>,
) -> AppResult<Value> {
    if !["list", "install", "verify", "remove"].contains(&action.as_str()) {
        return Err(AppError::msg("Unknown model action"));
    }
    let env = env_for(&state)?;
    let mut args = vec!["models".to_string(), action.clone()];
    if let Some(id) = &id {
        args.push(id.clone());
    }
    let model_id = id.clone().unwrap_or_default();
    let res = worker::run(env.command(&args), None, None, move |msg| {
        if let WorkerMsg::Progress { progress, .. } = msg {
            let _ = app.emit(
                "models://progress",
                ModelProgress {
                    id: model_id.clone(),
                    progress: *progress,
                },
            );
        }
    })
    .await;
    *state.info_cache.lock().unwrap() = None;
    res
}

#[tauri::command]
pub async fn analyze_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> AppResult<Value> {
    let env = env_for(&state)?;
    allow(&app, Path::new(&path));
    worker::run_simple(&env, &["analyze", &path]).await
}

/// Return a path the web view can decode for playback. Formats the web view
/// cannot decode (or `force`) are converted to a 16-bit WAV preview.
#[tauri::command]
pub async fn playback_path(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    force: Option<bool>,
) -> AppResult<String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(AppError::Worker {
            code: "not_found".into(),
            message: format!("File not found: {path}"),
        });
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if PLAYABLE.contains(&ext.as_str()) && !force.unwrap_or(false) {
        allow(&app, &p);
        return Ok(path);
    }
    let meta = std::fs::metadata(&p)?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let key = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(format!("{path}|{}|{modified}", meta.len()).as_bytes());
        digest
            .iter()
            .take(10)
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    };
    let preview = state.paths.previews.join(format!("{key}.wav"));
    if !preview.is_file() {
        let env = env_for(&state)?;
        worker::run_simple(&env, &["preview", &path, &preview.to_string_lossy()]).await?;
    }
    allow(&app, &preview);
    Ok(preview.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn allow_files(app: AppHandle, paths: Vec<String>) {
    for p in paths {
        allow(&app, Path::new(&p));
    }
}

/// Expand dropped/selected paths: folders are scanned (recursively) for audio files.
#[tauri::command]
pub fn expand_audio_paths(paths: Vec<String>) -> Vec<String> {
    fn is_audio(p: &Path) -> bool {
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
    }
    fn walk(dir: &Path, out: &mut Vec<String>, depth: usize) {
        if depth > 8 {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        let mut entries: Vec<_> = entries.flatten().map(|e| e.path()).collect();
        entries.sort();
        for p in entries {
            if p.is_dir() {
                walk(&p, out, depth + 1);
            } else if is_audio(&p) {
                out.push(p.to_string_lossy().into_owned());
            }
        }
    }
    let mut out = Vec::new();
    for p in paths {
        let path = PathBuf::from(&p);
        if path.is_dir() {
            walk(&path, &mut out, 0);
        } else if is_audio(&path) {
            out.push(p);
        }
    }
    out.dedup();
    out
}

#[tauri::command]
pub fn default_output_dir(app: AppHandle, state: State<'_, AppState>) -> String {
    if let Some(dir) = state.settings.read().unwrap().output_dir.clone() {
        return dir;
    }
    let base = app
        .path()
        .audio_dir()
        .or_else(|_| app.path().home_dir())
        .unwrap_or_else(|_| PathBuf::from("."));
    base.join("Resona").to_string_lossy().into_owned()
}

#[tauri::command]
pub fn enqueue_jobs(
    app: AppHandle,
    state: State<'_, AppState>,
    requests: Vec<JobRequest>,
) -> AppResult<Vec<Job>> {
    for r in &requests {
        if !Path::new(&r.input).is_file() {
            return Err(AppError::Worker {
                code: "not_found".into(),
                message: format!("File not found: {}", r.input),
            });
        }
        std::fs::create_dir_all(&r.output_dir).map_err(|e| {
            AppError::msg(format!("Cannot create output folder {}: {e}", r.output_dir))
        })?;
    }
    let (suffix, overwrite) = {
        let s = state.settings.read().unwrap();
        (s.filename_suffix.clone(), s.overwrite)
    };
    let jobs = state.jobs.enqueue(&app, requests, &suffix, overwrite);
    for j in &jobs {
        allow(&app, Path::new(&j.input));
        allow(&app, Path::new(&j.output));
    }
    Ok(jobs)
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Vec<Job> {
    state.jobs.list()
}

#[tauri::command]
pub fn cancel_job(app: AppHandle, state: State<'_, AppState>, id: String) -> bool {
    state.jobs.cancel(&app, &id)
}

#[tauri::command]
pub fn cancel_all_jobs(app: AppHandle, state: State<'_, AppState>) {
    state.jobs.cancel_all(&app);
}

#[tauri::command]
pub fn clear_jobs(state: State<'_, AppState>, id: Option<String>) {
    state.jobs.clear(id.as_deref());
}

#[tauri::command]
pub async fn run_benchmark(state: State<'_, AppState>, seconds: Option<f64>) -> AppResult<Value> {
    let env = env_for(&state)?;
    let device = state.settings.read().unwrap().device.clone();
    let secs = format!("{}", seconds.unwrap_or(30.0).clamp(5.0, 600.0));
    worker::run_simple(&env, &["bench", "--device", &device, "--seconds", &secs]).await
}
