# Third-party notices

Resona itself is MIT-licensed. It uses or downloads the following third-party components, each under its own licence.

## Downloaded at runtime (not bundled)

| Component | Licence | Notes |
|---|---|---|
| DeepFilterNet3 model (ONNX) | MIT OR Apache-2.0 | © Hendrik Schröter et al. https://github.com/Rikorose/DeepFilterNet |
| uv | MIT OR Apache-2.0 | © Astral Software Inc. Used to install the private Python runtime. |
| CPython (python-build-standalone) | PSF License | Installed by uv into Resona's data folder. |
| NumPy | BSD-3-Clause | |
| SciPy | BSD-3-Clause | |
| python-soundfile / libsndfile | BSD-3-Clause / LGPL-2.1 | libsndfile is dynamically loaded. |
| ONNX Runtime (CPU / GPU / DirectML) | MIT | GPU builds pull NVIDIA CUDA/cuDNN runtime wheels under the NVIDIA EULA. |
| FFmpeg (optional, user-installed) | LGPL/GPL depending on the build | Not shipped with Resona. |

## Bundled in the application

| Component | Licence |
|---|---|
| Tauri, tauri plugins | MIT OR Apache-2.0 |
| React, React DOM | MIT |
| Zustand | MIT |
| WaveSurfer.js | BSD-3-Clause |
| Lucide icons | ISC |
| Inter typeface (@fontsource-variable/inter) | SIL Open Font License 1.1 |
| Tailwind CSS (build-time) | MIT |
| Rust crates (serde, tokio, sha2, ureq, zip, flate2, tar, uuid, thiserror, log) | MIT and/or Apache-2.0 |

## Design references

* The default colour themes use the **Solarized** palette by Ethan Schoonover (MIT).
* Other themes are original palettes inspired by common editor and app styles. They contain no third-party assets.
