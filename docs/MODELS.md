# Models

Resona only uses pretrained models that:

1. Have a licence that allows redistribution and commercial use.
2. Can be downloaded from an **immutable** URL (a git commit or versioned release, never a branch).
3. Are verified by SHA-256: the archive *and* every extracted file.

Models are downloaded on demand into the app data folder (`…/io.github.resona/models/<id>/`), never bundled in the installer.

## DeepFilterNet3

| | |
|---|---|
| **Task** | Speech enhancement / noise suppression, full-band 48 kHz |
| **Authors** | Hendrik Schröter, Tobias Rosenkranz, Alberto N. Escalante-B., Andreas Maier |
| **Paper** | *DeepFilterNet: Perceptually Motivated Real-Time Speech Enhancement*, Interspeech 2023 |
| **Licence** | MIT OR Apache-2.0 (dual) |
| **Source** | https://github.com/Rikorose/DeepFilterNet |
| **File** | `models/DeepFilterNet3_onnx.tar.gz` at commit `84d57ec2c08fe08e68a13fb32a58cd7092060a0f` (2023-05-23) |
| **Archive SHA-256** | `c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616` (7,983,136 bytes) |
| `enc.onnx` | `7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916` |
| `erb_dec.onnx` | `ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895` |
| `df_dec.onnx` | `23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a` |
| `config.ini` | `415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290` |

**How Resona uses it**

* *Noise reduction (AI)*: applied per channel, with ERB gains averaged across channels (stereo-linked). Strength maps to DeepFilterNet's attenuation limit: 6 dB … 36 dB, or unlimited at 100 %.
* *Vocal clarity (experimental)*: run on the mid (L+R)/2 signal to estimate the centre vocal. That estimate is added back at +0.5…+6 dB.

**Verification.** The NumPy/ONNX port was compared with the official `deepfilternet==0.5.6` package (PyTorch 2.0.1, CPU) on `assets/noisy_snr0.wav` from the DeepFilterNet repository:

| Setting | Max abs. difference | Match-SNR |
|---|---|---|
| Full enhancement | 3.2·10⁻⁴ | 77.7 dB |
| 12 dB attenuation limit | 2.4·10⁻⁴ | 80.4 dB |

`worker/tests/fixtures/dfn3_reference.npz` stores the first 2 s of that input and of the reference outputs (float16) for the CI regression test. A further test adds white noise at 5 dB SNR to clean speech and requires an SNR improvement of more than 5 dB.

**Limitations.** Trained for speech. On full music mixes it attenuates instruments, so it is not the default for the *Music* preset.

## Adding a model

1. Confirm the licence of both the **code** and the **weights**, and record them.
2. Add a `ModelSpec` to `worker/resona_worker/models/registry.py`. It needs a pinned URL, the archive SHA-256, the per-file SHA-256s, and a description that includes honest limitations.
3. Implement inference in `worker/resona_worker/models/`. Prefer ONNX Runtime. A PyTorch model must be optional and must not become a hard dependency of the core engine.
4. Add a regression test against the upstream implementation (see `tests/test_deepfilternet.py`) and an objective quality test.
5. Document it in this file and in the README's model table, and mark it *experimental* until it is evaluated.

## Candidates evaluated but not shipped (v0.1.0)

| Model | Why not yet |
|---|---|
| AudioSR (versatile audio super-resolution) | Code is MIT, but the weight licence needs confirmation. Large (GBs), slow without a GPU, and pinned to old library versions. |
| Apollo (music restoration of lossy audio) | Weights are CC BY-SA 4.0 (share-alike); needs PyTorch. Planned as an optional engine. |
| Demucs (htdemucs) | MIT. Needs PyTorch; planned for stem-aware vocal enhancement. |
| HiFi-GAN-BWE / AP-BWE | Speech-only bandwidth extension; not suitable for music. |
