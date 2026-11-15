# Development guide

## Prerequisites

* **Node.js 20+** and npm
* **Rust** (stable) with the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS:
  * Windows: Microsoft C++ Build Tools and WebView2 (preinstalled on Windows 11)
  * macOS: Xcode Command Line Tools
  * Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libgtk-3-dev`
* **Python 3.10–3.12**. [uv](https://github.com/astral-sh/uv) is recommended.

## Setup

```bash
npm install
# Worker environment used automatically by debug builds:
uv venv worker/.venv --python 3.12
uv pip install --python worker/.venv -r worker/requirements/dev.txt
# Optional: download the model for the worker tests
worker/.venv/bin/python -m resona_worker --models-dir .models models install deepfilternet3   # Scripts\python on Windows
```

## Running

```bash
npm run tauri dev
```

Debug builds look for the worker in `../worker` and its interpreter in `worker/.venv`, unless *Settings → AI engine* points to another interpreter. You can also override this with `RESONA_PYTHON` / `RESONA_WORKER_DIR`. Set `RESONA_DATA_DIR` to keep all app data in one folder (portable mode).

### Browser preview (UI work without Tauri)

```bash
RESONA_DEMO_DIR=/path/to/folder/with/degraded.mp3+degraded_resona.flac VITE_RESONA_MOCK=1 npm run dev
# open http://localhost:1420/?scenario=done&theme=clay-dark
```

`src/dev/mock.ts` replaces the backend with Tauri's official IPC mocks and fixtures recorded from the real worker (`src/dev/fixtures/`). Scenarios: `empty`, `loaded`, `processing`, `done`, `settings`, `models`. This code is excluded from production builds.

### Worker CLI

The worker is fully usable without the app:

```bash
cd worker
python -m resona_worker info
python -m resona_worker analyze song.mp3
echo '{"input":"song.mp3","output":"song_resona.flac","preset":"music"}' | python -m resona_worker process --job -
python -m resona_worker bench --seconds 60
```

## Tests

| Suite | Command | Covers |
|---|---|---|
| Frontend | `npm test` | formatting, loudness-match maths, presets, WCAG contrast of every theme |
| Worker | `cd worker && pytest` | BS.1770 (EBU 3341 cases), true peak, limiter, STFT reconstruction, chunk seamlessness, resampling, declip SNR gain, de-hiss, cut-off detection on real MP3 encodes, CLI end-to-end for every format, alignment to ±1 sample, cancellation without partial files |
| Model | `RESONA_MODELS_DIR=… pytest` | DeepFilterNet3 vs the official implementation, SNR improvement, chunked = whole |
| Backend | `cd src-tauri && cargo test` | settings, protocol parsing, unique output names, temp cleanup, uv archive extraction, **headless end-to-end queue test** (real worker, completion and cancellation) |
| Engine install | `RESONA_ENGINE_VARIANT=cpu cargo test -- --ignored engine_install` | real uv download and checksum, Python install, package install, verification (network) |

Lint: `npm run lint`, `cd worker && ruff check .`, `cd src-tauri && cargo clippy --all-targets -- -D warnings && cargo fmt --check`.

## Building installers

```bash
npm run tauri build
```

Output goes to `src-tauri/target/release/bundle/`: NSIS `.exe` and `.msi` on Windows, `.app`/`.dmg` on macOS, `.AppImage`/`.deb`/`.rpm` on Linux. Remove `worker/resona_worker/**/__pycache__` first so bytecode isn't bundled.

The **Release** workflow (`.github/workflows/release.yml`) builds every platform on a `v*` tag and attaches the installers to a draft GitHub release.

## Icons

The app icon comes from `assets/app-icon.png` (the logo mark on a Solarized tile). To regenerate it:

```bash
npx tauri icon assets/app-icon.png -o src-tauri/icons
```
