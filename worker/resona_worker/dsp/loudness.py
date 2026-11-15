"""ITU-R BS.1770-4 loudness (LUFS) and true-peak measurement.

The K-weighting filter coefficients are derived for any sample rate with the
same analogue prototype as libebur128, which reproduces the reference 48 kHz
coefficients from the recommendation.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.signal import lfilter, resample_poly

ABSOLUTE_GATE = -70.0
RELATIVE_GATE = -10.0


def k_weighting(sr: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    # Stage 1: high-shelf "head" filter.
    f0 = 1681.974450955533
    g = 3.999843853973347
    q = 0.7071752369554196
    k = math.tan(math.pi * f0 / sr)
    vh = 10.0 ** (g / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / q + k * k
    b1 = np.array([(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0])
    a1 = np.array([1.0, 2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0])
    # Stage 2: RLB high-pass.
    f0 = 38.13547087602444
    q = 0.5003270373238773
    k = math.tan(math.pi * f0 / sr)
    b2 = np.array([1.0, -2.0, 1.0])
    d = 1.0 + k / q + k * k
    a2 = np.array([1.0, 2.0 * (k * k - 1.0) / d, (1.0 - k / q + k * k) / d])
    return b1, a1, b2, a2


def _channel_weights(channels: int) -> np.ndarray:
    w = np.ones(channels)
    if channels == 6:  # L R C LFE Ls Rs
        w = np.array([1.0, 1.0, 1.0, 0.0, 1.41, 1.41])
    return w


def block_energies(audio: np.ndarray, sr: int, block_s: float = 0.4, overlap: float = 0.75) -> np.ndarray:
    """Weighted mean-square energy per gating block (summed across channels)."""
    b1, a1, b2, a2 = k_weighting(sr)
    weights = _channel_weights(audio.shape[0])
    block = int(round(block_s * sr))
    step = max(1, int(round(block * (1.0 - overlap))))
    n = audio.shape[1]
    if n < block:
        block = n
        step = max(n, 1)
    if n == 0:
        return np.zeros(0)
    n_blocks = 1 + (n - block) // step
    total = np.zeros(n_blocks)
    for c in range(audio.shape[0]):
        if weights[c] == 0:
            continue
        y = lfilter(b2, a2, lfilter(b1, a1, audio[c].astype(np.float64)))
        cs = np.concatenate(([0.0], np.cumsum(y * y)))
        starts = np.arange(n_blocks) * step
        total += weights[c] * (cs[starts + block] - cs[starts]) / block
    return total


def integrated_loudness(audio: np.ndarray, sr: int) -> float:
    """Integrated loudness in LUFS (``-inf`` for digital silence)."""
    z = block_energies(audio, sr)
    if z.size == 0:
        return float("-inf")
    with np.errstate(divide="ignore"):
        lk = -0.691 + 10.0 * np.log10(z)
    gated = z[lk > ABSOLUTE_GATE]
    if gated.size == 0:
        return float("-inf")
    rel = -0.691 + 10.0 * math.log10(gated.mean()) + RELATIVE_GATE
    gated = z[(lk > ABSOLUTE_GATE) & (lk > rel)]
    if gated.size == 0:
        return float("-inf")
    return float(-0.691 + 10.0 * math.log10(gated.mean()))


def true_peak(audio: np.ndarray, oversample: int = 4, chunk: int = 1 << 20) -> float:
    """Estimated true peak (linear) using polyphase oversampling (BS.1770-4 Annex 2)."""
    peak = 0.0
    n = audio.shape[-1]
    pad = 64
    for start in range(0, n, chunk):
        a = max(0, start - pad)
        b = min(n, start + chunk + pad)
        up = resample_poly(audio[:, a:b], oversample, 1, axis=-1)
        peak = max(peak, float(np.max(np.abs(up))) if up.size else 0.0)
    sample_peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    return max(peak, sample_peak)


def to_db(x: float) -> float:
    return 20.0 * math.log10(x) if x > 0 else float("-inf")


def db_to_gain(db: float) -> float:
    return 10.0 ** (db / 20.0)
