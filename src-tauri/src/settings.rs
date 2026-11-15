use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;

/// User preferences persisted to `settings.json` in the app config directory.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Color theme id (see src/lib/themes.ts) or "system".
    pub theme: String,
    /// "auto" | "cpu" | "cuda" | "directml" | "coreml" | "rocm"
    pub device: String,
    /// ONNX Runtime intra-op threads (0 = automatic).
    pub threads: u32,
    /// Number of files processed at the same time.
    pub concurrency: u32,
    pub output_dir: Option<String>,
    pub format: String,
    pub bit_depth: u32,
    pub bitrate_kbps: u32,
    /// 0 = keep the source rate (or 48 kHz when upscaling low-rate audio).
    pub sample_rate: u32,
    /// "match" | "normalize" | "off"
    pub loudness_mode: String,
    pub target_lufs: f64,
    pub true_peak_db: f64,
    pub chunk_seconds: f64,
    pub filename_suffix: String,
    pub overwrite: bool,
    /// Compare A/B with the original gain-matched to the output.
    pub loudness_matched_ab: bool,
    /// Optional interpreter override (advanced; skips the managed engine).
    pub python_path: Option<String>,
    pub ffmpeg_path: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "solarized-dark".into(),
            device: "auto".into(),
            threads: 0,
            concurrency: 1,
            output_dir: None,
            format: "flac".into(),
            bit_depth: 24,
            bitrate_kbps: 320,
            sample_rate: 0,
            loudness_mode: "match".into(),
            target_lufs: -14.0,
            true_peak_db: -1.0,
            chunk_seconds: 20.0,
            filename_suffix: "_resona".into(),
            overwrite: false,
            loudness_matched_ab: true,
            python_path: None,
            ffmpeg_path: None,
        }
    }
}

impl Settings {
    pub fn load(dir: &Path) -> Settings {
        let path = dir.join("settings.json");
        match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str::<Settings>(&text)
                .map(|s| s.sanitized())
                .unwrap_or_else(|e| {
                    log::warn!("Ignoring invalid settings file {}: {e}", path.display());
                    Settings::default()
                }),
            Err(_) => Settings::default(),
        }
    }

    pub fn save(&self, dir: &Path) -> AppResult<()> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join("settings.json");
        let tmp = dir.join("settings.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)?;
        Ok(())
    }

    /// Clamp values coming from disk or the UI into safe ranges.
    pub fn sanitized(mut self) -> Settings {
        self.concurrency = self.concurrency.clamp(1, 4);
        self.threads = self.threads.min(64);
        if ![16, 24, 32].contains(&self.bit_depth) {
            self.bit_depth = 24;
        }
        self.bitrate_kbps = self.bitrate_kbps.clamp(64, 320);
        self.true_peak_db = self.true_peak_db.clamp(-12.0, 0.0);
        self.target_lufs = self.target_lufs.clamp(-40.0, -5.0);
        self.chunk_seconds = self.chunk_seconds.clamp(5.0, 600.0);
        if !["match", "normalize", "off"].contains(&self.loudness_mode.as_str()) {
            self.loudness_mode = "match".into();
        }
        if self.filename_suffix.contains(['/', '\\', ':']) {
            self.filename_suffix = "_resona".into();
        }
        if self.theme.is_empty() || self.theme.len() > 40 {
            self.theme = "solarized-dark".into();
        }
        self.python_path = self.python_path.filter(|p| !p.trim().is_empty());
        self.ffmpeg_path = self.ffmpeg_path.filter(|p| !p.trim().is_empty());
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_defaults() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(dir.path()), Settings::default());
        let s = Settings {
            format: "mp3".into(),
            ..Settings::default()
        };
        s.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).format, "mp3");
    }

    #[test]
    fn partial_and_invalid_values_are_sanitized() {
        let s: Settings =
            serde_json::from_str(r#"{"concurrency": 99, "bitDepth": 7, "filenameSuffix": "../x"}"#)
                .unwrap();
        let s = s.sanitized();
        assert_eq!(s.concurrency, 4);
        assert_eq!(s.bit_depth, 24);
        assert_eq!(s.filename_suffix, "_resona");
        assert_eq!(s.theme, "solarized-dark");
    }
}
