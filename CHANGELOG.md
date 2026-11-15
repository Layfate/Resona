# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-14

First public MVP.

### Added
- Desktop app (Tauri 2, React, TypeScript, Tailwind) with drag-and-drop import of files and folders.
- Automatic diagnosis per file: clipping, codec/low-rate band limit, loudness (BS.1770-4), true peak, noise floor.
- Processing stages:
  - DeepFilterNet3 AI noise reduction (ONNX Runtime port, verified against the official implementation).
  - Music-safe spectral de-hiss.
  - AR declipping.
  - DSP bandwidth extension (spectral band replication) with automatic upsampling of low-rate audio to 48 kHz.
  - Experimental vocal clarity.
- Presets: Music, Vocals, Restoration, Custom.
- Loudness matching and a true-peak limiter (default ceiling −1 dBTP); exact duration and alignment preserved.
- Synchronised waveforms, instant loudness-matched A/B playback, and an average-spectrum comparison chart.
- Batch queue with progress, per-file and global cancel, unique output names and atomic writes.
- Export to WAV, FLAC, AIFF, MP3, Ogg Vorbis and Opus; AAC/ALAC through FFmpeg.
- Managed AI engine installer (pinned uv, private Python 3.12) with CPU, CUDA and DirectML variants.
- Model download with SHA-256 verification; model management UI showing licences and limitations.
- Nine contrast-tested colour themes (Solarized Dark by default) and Match System.
- Benchmark tool, CI for Windows/macOS/Linux, and release workflow for `.exe`, `.msi`, `.dmg`, `.AppImage`, `.deb` and `.rpm`.

### Known limitations
- macOS and Linux builds are not yet hand-verified; installers are not code-signed.
- No neural super-resolution model yet (bandwidth extension is DSP).
- Clipping that was later lossy-encoded is not reliably detected.
