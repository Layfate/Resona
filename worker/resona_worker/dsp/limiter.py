"""Offline, look-ahead true-peak limiter with stereo-linked gain.

Because Resona processes files offline, the limiter can be non-causal: the
required gain is computed for every sample, a minimum filter "holds" the
gain reduction across ±``window`` samples and a box filter of the same length
smooths it. Any average over a span of ``window`` samples of the held curve is
<= the required gain at the centre, so the ceiling is guaranteed while the gain
curve stays smooth (no hard clipping distortion).
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import minimum_filter1d, uniform_filter1d
from scipy.signal import resample_poly


def _peak_envelope(audio: np.ndarray, oversample: int = 4) -> np.ndarray:
    """Per-sample, channel-linked true-peak envelope."""
    n = audio.shape[-1]
    env = np.max(np.abs(audio), axis=0)
    if oversample > 1 and n > 0:
        chunk = 1 << 20
        out = np.empty(n, dtype=np.float32)
        for start in range(0, n, chunk):
            a = max(0, start - 32)
            b = min(n, start + chunk + 32)
            up = resample_poly(audio[:, a:b], oversample, 1, axis=-1)
            up_env = np.max(np.abs(up), axis=0)
            m = (b - a)
            up_env = up_env[: m * oversample].reshape(m, oversample).max(axis=1)
            out[start:min(n, start + chunk)] = up_env[start - a: start - a + min(chunk, n - start)]
        env = np.maximum(env, out)
    return env


def limit(audio: np.ndarray, sr: int, ceiling_db: float = -1.0, window_ms: float = 6.0) -> tuple[np.ndarray, float]:
    """Return ``(limited_audio, max_gain_reduction_db)``."""
    ceiling = 10.0 ** (ceiling_db / 20.0)
    env = _peak_envelope(audio)
    if env.size == 0 or float(env.max()) <= ceiling:
        return audio, 0.0
    with np.errstate(divide="ignore"):
        g_req = np.minimum(1.0, ceiling / np.maximum(env, 1e-12)).astype(np.float32)
    w = max(3, int(round(window_ms * 1e-3 * sr)) | 1)
    held = minimum_filter1d(g_req, size=2 * w + 1, mode="nearest")
    smooth = uniform_filter1d(held, size=w, mode="nearest")
    smooth = np.minimum(smooth, g_req)  # numerical safety; never exceed required gain
    out = audio * smooth[None, :]
    # Inter-sample overs can survive extreme cases; final safety clamp at the ceiling.
    out = np.clip(out, -ceiling, ceiling)
    reduction = float(-20.0 * np.log10(max(float(smooth.min()), 1e-9)))
    return out.astype(np.float32), reduction
