"""High-quality rational resampling with exact output length."""

from __future__ import annotations

from fractions import Fraction

import numpy as np
from scipy.signal import resample_poly


def expected_length(n_in: int, sr_in: int, sr_out: int) -> int:
    return int(round(n_in * sr_out / sr_in))


def resample(audio: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    """Resample ``[C, N]`` audio; output length is exactly ``round(N * sr_out / sr_in)``.

    Uses a polyphase FIR with a Kaiser(β=8.6) window, which gives >90 dB stop-band
    attenuation – far better than the SciPy default (β=5).
    """
    if sr_in == sr_out:
        return audio.astype(np.float32, copy=False)
    frac = Fraction(sr_out, sr_in).limit_denominator(1000)
    up, down = frac.numerator, frac.denominator
    out = resample_poly(audio, up, down, axis=-1, window=("kaiser", 8.6)).astype(np.float32)
    return fix_length(out, expected_length(audio.shape[-1], sr_in, sr_out))


def fix_length(audio: np.ndarray, n: int) -> np.ndarray:
    cur = audio.shape[-1]
    if cur == n:
        return audio
    if cur > n:
        return audio[..., :n]
    pad = [(0, 0)] * (audio.ndim - 1) + [(0, n - cur)]
    return np.pad(audio, pad)
