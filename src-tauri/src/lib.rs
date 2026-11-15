//! Resona desktop backend.
//!
//! The Rust side owns application state (settings, job queue, engine
//! installation) and spawns the Python worker for all audio processing. No
//! audio is processed on the UI thread or in this process.

mod commands;
mod engine;
mod error;
mod jobs;
mod paths;
mod settings;
mod worker;

use std::sync::{Arc, Mutex, OnceLock, RwLock};

use serde_json::Value;
use tauri::{Manager, Runtime};

pub struct AppState {
    pub paths: paths::Paths,
    pub settings: RwLock<settings::Settings>,
    pub jobs: Arc<jobs::JobManager>,
    pub installer: engine::EngineInstaller,
    pub info_cache: Mutex<Option<Value>>,
    pub nvidia: OnceLock<bool>,
}

/// Create application state and start the job scheduler.
fn setup<R: Runtime>(handle: &tauri::AppHandle<R>) -> Result<(), Box<dyn std::error::Error>> {
    let paths = paths::Paths::resolve(handle)?;
    let settings = settings::Settings::load(&paths.config);
    log::info!(
        "Resona {} starting; data dir {}",
        env!("CARGO_PKG_VERSION"),
        paths.app_data.display()
    );
    log::info!("Worker package: {}", paths.worker.display());
    let jobs = Arc::new(jobs::JobManager::default());
    jobs.set_concurrency(settings.concurrency as usize);
    handle.manage(AppState {
        paths,
        settings: RwLock::new(settings),
        jobs: jobs.clone(),
        installer: engine::EngineInstaller::default(),
        info_cache: Mutex::new(None),
        nvidia: OnceLock::new(),
    });
    let provider_handle = handle.clone();
    let provider: jobs::EnvProvider = Arc::new(move || {
        let state = provider_handle.state::<AppState>();
        let settings = state.settings.read().unwrap().clone();
        worker::WorkerEnv::new(&state.paths, &settings)
    });
    tauri::async_runtime::spawn(jobs.run_scheduler(handle.clone(), provider));
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .level_for("worker", log::LevelFilter::Info)
                .max_file_size(5_000_000)
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| setup(app.handle()))
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::engine_info,
            commands::install_engine,
            commands::cancel_engine_install,
            commands::remove_engine,
            commands::get_settings,
            commands::save_settings,
            commands::model_action,
            commands::analyze_file,
            commands::playback_path,
            commands::allow_files,
            commands::expand_audio_paths,
            commands::default_output_dir,
            commands::enqueue_jobs,
            commands::list_jobs,
            commands::cancel_job,
            commands::cancel_all_jobs,
            commands::clear_jobs,
            commands::run_benchmark,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Resona");
}

/// End-to-end tests on Tauri's mock runtime: real job scheduler, real worker
/// processes, no window. Skipped when no worker Python environment is found.
#[cfg(test)]
mod integration {
    use super::*;
    use std::path::Path;
    use std::time::{Duration, Instant};

    fn write_wav(path: &Path, seconds: f32, sr: u32) {
        let n = (seconds * sr as f32) as u32;
        let mut data = Vec::with_capacity(44 + n as usize * 4);
        let bytes = n * 4;
        data.extend_from_slice(b"RIFF");
        data.extend_from_slice(&(36 + bytes).to_le_bytes());
        data.extend_from_slice(b"WAVEfmt ");
        data.extend_from_slice(&16u32.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes()); // PCM
        data.extend_from_slice(&2u16.to_le_bytes()); // stereo
        data.extend_from_slice(&sr.to_le_bytes());
        data.extend_from_slice(&(sr * 4).to_le_bytes());
        data.extend_from_slice(&4u16.to_le_bytes());
        data.extend_from_slice(&16u16.to_le_bytes());
        data.extend_from_slice(b"data");
        data.extend_from_slice(&bytes.to_le_bytes());
        let mut seed = 12345u32;
        for i in 0..n {
            seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
            let noise = ((seed >> 16) as f32 / 32768.0 - 1.0) * 0.01;
            let t = i as f32 / sr as f32;
            let s = (0.4 * (2.0 * std::f32::consts::PI * 440.0 * t).sin() + noise).clamp(-1.0, 1.0);
            let v = (s * 32767.0) as i16;
            data.extend_from_slice(&v.to_le_bytes());
            data.extend_from_slice(&v.to_le_bytes());
        }
        std::fs::write(path, data).unwrap();
    }

    fn wait_for<R: Runtime>(
        app: &tauri::AppHandle<R>,
        id: &str,
        pred: impl Fn(&jobs::Job) -> bool,
        secs: u64,
    ) -> jobs::Job {
        let start = Instant::now();
        loop {
            let job = app
                .state::<AppState>()
                .jobs
                .list()
                .into_iter()
                .find(|j| j.id == id)
                .unwrap();
            if pred(&job) {
                return job;
            }
            assert!(
                start.elapsed() < Duration::from_secs(secs),
                "timed out; last state {:?}: {}",
                job.status,
                job.message
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    #[test]
    fn processes_and_cancels_jobs_through_the_queue() {
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("RESONA_DATA_DIR", dir.path().join("data"));
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        setup(&handle).unwrap();
        let state = handle.state::<AppState>();
        let settings = state.settings.read().unwrap().clone();
        if worker::resolve_python(&state.paths, &settings).is_none() {
            eprintln!("skipping: no worker Python environment (create worker/.venv)");
            return;
        }
        let input = dir.path().join("tone.wav");
        write_wav(&input, 4.0, 44100);
        let out_dir = dir.path().join("out");
        std::fs::create_dir_all(&out_dir).unwrap();
        let req = |input: &Path| jobs::JobRequest {
            input: input.to_string_lossy().into_owned(),
            output_dir: out_dir.to_string_lossy().into_owned(),
            output_stem: None,
            spec: serde_json::json!({ "preset": "music", "format": "flac" }),
        };

        // 1. A job runs to completion and produces the file.
        let job = state
            .jobs
            .enqueue(&handle, vec![req(&input)], "_resona", false)
            .remove(0);
        assert!(job.output.ends_with("tone_resona.flac"));
        let done = wait_for(&handle, &job.id, |j| j.status.is_finished(), 120);
        assert_eq!(done.status, jobs::JobStatus::Done, "{:?}", done.error);
        assert!(Path::new(&done.output).is_file());
        let result = done.result.unwrap();
        assert_eq!(result["sampleRateOut"], 44100);
        assert_eq!(result["framesOut"], result["framesIn"]);

        // 2. A second job for the same input gets a unique name.
        let long = dir.path().join("long.wav");
        write_wav(&long, 240.0, 44100);
        let j2 = state
            .jobs
            .enqueue(&handle, vec![req(&long)], "_resona", false)
            .remove(0);
        wait_for(
            &handle,
            &j2.id,
            |j| j.status == jobs::JobStatus::Running && j.progress > 0.05,
            120,
        );

        // 3. Cancelling kills the worker and leaves no partial output.
        assert!(state.jobs.cancel(&handle, &j2.id));
        let cancelled = wait_for(&handle, &j2.id, |j| j.status.is_finished(), 30);
        assert_eq!(cancelled.status, jobs::JobStatus::Cancelled);
        assert!(!Path::new(&cancelled.output).exists());
        let leftovers: Vec<_> = std::fs::read_dir(&out_dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".resona-"))
            .collect();
        assert!(leftovers.is_empty(), "temp files left behind");

        // 4. Finished jobs can be cleared.
        state.jobs.clear(None);
        assert!(state.jobs.list().is_empty());
    }
}

#[cfg(test)]
mod engine_install {
    use super::*;

    /// Downloads uv, a standalone CPython and the worker dependencies (~100+ MB).
    /// Run explicitly: `RESONA_ENGINE_VARIANT=cpu cargo test -- --ignored engine_install`
    #[test]
    #[ignore = "network: downloads the managed engine"]
    fn installs_and_verifies_managed_engine() {
        let dir = std::env::var_os("RESONA_TEST_ENGINE_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| tempfile::tempdir().unwrap().keep());
        std::env::set_var("RESONA_DATA_DIR", &dir);
        let variant = std::env::var("RESONA_ENGINE_VARIANT").unwrap_or_else(|_| "cpu".into());
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let handle = app.handle().clone();
        setup(&handle).unwrap();
        let state = handle.state::<AppState>();
        let manifest = tauri::async_runtime::block_on(state.installer.install(
            &handle,
            &state.paths,
            &variant,
        ))
        .unwrap();
        assert_eq!(manifest.variant, variant);
        assert!(state.paths.venv_python().is_file());
        assert!(engine::manifest(&state.paths).is_some());
        let env = worker::WorkerEnv::new(&state.paths, &state.settings.read().unwrap()).unwrap();
        assert_eq!(env.python, state.paths.venv_python());
        let info = tauri::async_runtime::block_on(worker::run_simple(&env, &["info"])).unwrap();
        eprintln!("engine devices: {}", info["devices"]["onnxDevices"]);
    }
}
