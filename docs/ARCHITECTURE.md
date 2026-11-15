# Architecture

Resona has three parts, each in its own language and process:

| Part | Tech | Responsibility |
|---|---|---|
| UI | React 19, TypeScript, Tailwind 4, WaveSurfer.js | Interaction, waveforms, A/B playback (Web Audio), themes |
| Core | Rust, Tauri 2 | Settings, job queue and scheduling, AI-engine installation, file access, spawning workers |
| Worker | Python 3.10+, NumPy, SciPy, libsndfile, ONNX Runtime | All decoding, analysis, DSP, neural inference and encoding |

```
src/            React app (UI only: no audio processing)
src-tauri/      Rust backend
  src/commands.rs   Tauri commands (the IPC surface)
  src/jobs.rs       batch queue, concurrency, cancellation, temp-file cleanup
  src/worker.rs     process spawning + JSON-lines protocol
  src/engine.rs     managed Python runtime via pinned uv
  src/settings.rs   persisted preferences
  src/paths.rs      data/config/cache/log/model locations
worker/
  resona_worker/    the Python package (bundled as a Tauri resource)
    pipeline.py       stage orchestration
    analysis.py       diagnosis (clipping, bandwidth, loudness, noise floor)
    audio_io.py       decode/encode (libsndfile, optional FFmpeg)
    dsp/              loudness, limiter, declip, de-hiss, bandwidth, STFT, chunking, resampling
    models/           registry (download/verify) + DeepFilterNet3 ONNX inference
  requirements/     engine variants (cpu, cuda, directml)
  tests/
```

## Process model

Every operation (`info`, `analyze`, `preview`, `process`, `models …`, `bench`) runs in a **new worker process**:

* The UI process never loads native audio or ML libraries.
* **Cancellation is a kill.** It is immediate and reliable, even inside a long native call.
* **Resources are always released.** When a job ends, the OS reclaims every byte of RAM and VRAM.
* A crash in a native library fails one job, not the app.

Model loading costs ~100 ms per job for DeepFilterNet3, which is negligible next to processing.

### Protocol

The worker writes one JSON object per line to **stdout**. Logs and tracebacks go to **stderr**. `protocol.install_stdout_guard()` redirects stray `print`s, so nothing can corrupt the stream.

```json
{"type":"progress","stage":"process","progress":0.42,"message":"Enhancing"}
{"type":"log","level":"info","message":"DeepFilterNet3 running on cpu"}
{"type":"result","data":{ "...": "..." }}
{"type":"error","code":"model_missing","message":"DeepFilterNet3 is not installed…"}
```

Exactly one `result` or `error` ends each run. Progress is monotonic and rate-limited to 10 messages per second. Exit codes: 0 success, 1 handled error, 2 crash. If the process dies without a result, the Rust side reports the tail of stderr.

Job specs are passed on **stdin** (`process --job -`), so paths with spaces or Unicode need no quoting.

## The processing pipeline

```
decode ─► declip (native rate) ─► resample ─► global analysis ─► [chunks] ─► master ─► encode
                                               │                    │
                                               │ noise profile      ├─ denoise (DSP or DeepFilterNet3)
                                               │ bandwidth cut-off  ├─ vocal clarity
                                               │ input loudness     └─ bandwidth extension
```

* **Declipping runs first, at the native sample rate.** Resampling would smear the flat tops it needs to detect.
* **Global analysis before chunking.** The noise profile, the cut-off and the reference loudness are measured once, so every chunk uses identical parameters.
* **Chunking** (`dsp/chunking.py`): cores of *N* seconds (default 20) are processed with 2 s of context on each side. Only the core plus a 0.5 s linear crossfade is kept. Adjacent ramps are amplitude-complementary, so identical outputs reconstruct exactly. The context lets recurrent models and running normalisations warm up. A test checks that a non-causal filter processed in chunks matches whole-file processing to > 60 dB.
* **Mastering**: integrated loudness (BS.1770-4) is matched to the input (or normalised to a target). A non-causal look-ahead **true-peak limiter** follows: gain is held by a min-filter over ±w and smoothed by a box filter of width w. Any average over the hold window is ≤ the required gain, so the ceiling is guaranteed without hard clipping. The limiter is channel-linked to keep the stereo image.
* **Exact duration**: output length is forced to `round(N_in · sr_out / sr_in)` samples. Tests check click positions survive processing to within ±1 sample on each channel.
* **Atomic output**: the encoder writes `.<name>.resona-XXXX.tmp.<ext>` and renames it on success. The Rust side deletes leftovers on cancel or failure.

## DeepFilterNet3 inference

`models/deepfilternet.py` re-implements the offline `df.enhance.enhance` path around the three published ONNX graphs (`enc`, `erb_dec`, `df_dec`):

1. libDF's STFT: Vorbis window, n_fft 960, hop 480, analysis-only normalisation.
2. Features: ERB-band log power with exponential mean normalisation (α = 0.99, initial state −60…−90 dB), and the unit-normalised complex spectrum of the lowest 96 bins.
3. Two-frame look-ahead shift of the features (`pad_feat`).
4. Encoder → ERB decoder (32 band gains, applied across each band's bins) and DF decoder (order-5 complex filters over frames t−2…t+2 on the low 96 bins).
5. Optional attenuation limit: `spec·lim + enhanced·(1−lim)`.
6. libDF synthesis, then delay compensation of n_fft − hop samples.

It matches the official PyTorch implementation to a 77.7 dB match-SNR on the project's demo file. `tests/test_deepfilternet.py` re-checks this against a stored reference in CI.

## A/B playback

`src/lib/player.ts` decodes both versions into `AudioBuffer`s and starts two `AudioBufferSourceNode`s at the same scheduled instant. Switching A/B ramps two gain nodes (8 ms time constant), so it is instant and sample-aligned. Loudness matching attenuates the louder side and never boosts above unity. Files longer than 25 minutes fall back to two `<audio>` elements to bound memory.

Waveforms are drawn by WaveSurfer.js from **peaks computed by the worker** (2,400 points). Long files never need decoding just to draw them, and the canvas renders instantly.

## AI engine installation

`engine.rs` provisions a private runtime:

1. Download `uv` **0.12.19** for the current platform from GitHub Releases and verify it against a SHA-256 pinned in the source. Only the `uv` executable is extracted.
2. `uv venv --managed-python --python 3.12`: a standalone CPython in the app data folder, with `UV_PYTHON_INSTALL_DIR` and `UV_CACHE_DIR` pointed inside it.
3. `uv pip install -r requirements/<variant>.txt`.
4. Verify by running `python -m resona_worker info`, then write `engine.json`. Delete the download cache.

The system Python and PATH are never modified. Users can instead point Resona at their own interpreter (*Settings → AI engine*).

## Security notes

* **Asset protocol scope starts empty.** Files become readable by the web view only after the user imports them (`allow_file` at runtime).
* **Restrictive CSP.** No remote scripts; `connect-src` covers only IPC and the asset protocol.
* **Downloaded models are data only.** Each archive member is checked by SHA-256, and files are written under fixed names (archive paths are ignored, so there is no traversal).
* **The input file is never overwritten.** Both the queue and the worker refuse output paths that resolve to the input.

## UI theming

`src/lib/themes.ts` defines nine themes as full token sets, applied as CSS custom properties. Tailwind utilities reference those properties through `@theme inline`.

`themes.test.ts` enforces WCAG contrast for every theme:
- 7:1 for primary text.
- 4.5:1 for secondary text, button text and accent text.
- 3.5:1 for muted text.

The Original/Enhanced series colours were validated for colour-vision deficiency per theme surface.
