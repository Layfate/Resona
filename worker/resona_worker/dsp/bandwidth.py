"""Bandwidth analysis and DSP bandwidth extension.

``detect_cutoff`` finds the frequency above which a recording has (almost) no
energy – e.g. the 16 kHz low-pass of a 128 kbps MP3 or the Nyquist limit of a
22.05 kHz recording that was upsampled.

``extend`` synthesises plausible content above that cutoff with spectral band
replication (the technique used by HE-AAC/SBR): the octave below the cutoff is
transposed upwards and re-shaped with an extrapolated spectral envelope. The
transposition shift is a multiple of ``n_fft / hop`` bins, so the copied STFT
phases stay coherent across frames.

This is *not* recovery of the original high frequencies – that information is
gone. It adds "air" whose envelope follows the music. It is deliberately
conservative and is mixed only above the detected cutoff; the original band
is never modified.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter1d

from .stft import Stft

N_FFT = 2048
HOP = 512


def ltas_db(audio: np.ndarray, sr: int, n_fft: int = N_FFT) -> tuple[np.ndarray, np.ndarray]:
    """Long-term average spectrum (dB) and its frequency axis."""
    stft = Stft(n_fft, n_fft // 4)
    n = audio.shape[1]
    step = sr * 30
    acc = np.zeros(n_fft // 2 + 1, dtype=np.float64)
    frames = 0
    for a in range(0, max(n, 1), step):
        seg = audio[:, a:a + step]
        if seg.shape[1] == 0:
            break
        spec = stft.forward(seg)
        p = np.mean(np.abs(spec) ** 2, axis=0)
        acc += p.sum(axis=0)
        frames += p.shape[0]
    acc /= max(frames, 1)
    freqs = np.fft.rfftfreq(n_fft, 1.0 / sr)
    return (10.0 * np.log10(acc + 1e-20)).astype(np.float32), freqs


def detect_cutoff(audio: np.ndarray, sr: int) -> dict:
    """Detect a brick-wall low-pass (codec or resampler) in the long-term spectrum.

    Natural recordings roll off gradually; codecs and resamplers cut off steeply.
    A cutoff is reported only when the level falls by >= 25 dB within ~1.2 kHz,
    stays low all the way to Nyquist, and the band below is clearly above the floor.
    Returns ``{"cutoffHz", "nyquistHz", "bandLimited", "dropDb"}``.
    """
    ldb, freqs = ltas_db(audio, sr)
    nyq = sr / 2.0
    bin_hz = float(freqs[1])
    sm = uniform_filter1d(ldb, size=5, mode="nearest")
    n = len(sm)
    below = max(2, int(round(500.0 / bin_hz)))
    above = max(2, int(round(700.0 / bin_hz)))
    floor = float(np.median(sm[int(n * 0.96):]))
    # Running max from the top: tail_max[k] = max(sm[k:]).
    tail_max = np.maximum.accumulate(sm[::-1])[::-1]
    lo_bin = int(round(2000.0 / bin_hz))
    for k in range(n - above - 1, max(lo_bin, below), -1):
        a = float(sm[k - below])
        b = float(tail_max[k + above])
        if a - b >= 25.0 and a - floor >= 25.0:
            ref_lo = max(0, k - int(round(3000.0 / bin_hz)))
            ref_hi = max(ref_lo + 1, k - int(round(1000.0 / bin_hz)))
            ref = float(np.median(sm[ref_lo:ref_hi]))
            j = min(k + above, n - 1)
            while j > ref_lo and sm[j] < ref - 10.0:
                j -= 1
            cutoff = float(freqs[j])
            return {"cutoffHz": cutoff, "nyquistHz": nyq, "bandLimited": bool(cutoff < 0.92 * nyq),
                    "dropDb": a - b}
    return {"cutoffHz": nyq, "nyquistHz": nyq, "bandLimited": False, "dropDb": 0.0}


def _envelope_db(mag: np.ndarray, width: int) -> np.ndarray:
    return 20.0 * np.log10(uniform_filter1d(mag, size=width, axis=-1, mode="nearest") + 1e-9)


def extend(audio: np.ndarray, sr: int, cutoff_hz: float, strength: float = 0.5) -> np.ndarray:
    """Add synthesised content above ``cutoff_hz``. Returns audio of identical shape."""
    nyq = sr / 2.0
    if cutoff_hz >= 0.95 * nyq or strength <= 0:
        return audio
    stft = Stft(N_FFT, HOP)
    bin_hz = sr / N_FFT
    kc = int(round(cutoff_hz / bin_hz))
    kn = N_FFT // 2
    ratio = N_FFT // HOP  # phase-coherent shift granularity
    width = kc // 2  # replicate (at most) the octave below the cutoff
    shift = max(ratio, (width // ratio) * ratio)
    if kc - shift < 8:
        return audio
    spec = stft.forward(audio)  # [C, T, F]
    mag = np.abs(spec)
    target_bins = np.arange(kc, kn + 1)
    hops = np.ceil((target_bins - kc + 1) / shift).astype(int)
    src_bins = target_bins - hops * shift
    src_bins = np.clip(src_bins, kc - shift, kc - 1)

    # Per-frame envelope just below the cutoff and its slope (dB per octave).
    env = _envelope_db(mag, 9)  # [C, T, F]
    f_lo = max(int(kc * 0.5), 4)
    f_hi = max(int(kc * 0.92), f_lo + 4)
    xs = np.log2(np.arange(f_lo, f_hi) / kc)
    seg = env[..., f_lo:f_hi]
    x_mean = xs.mean()
    slope = ((seg - seg.mean(-1, keepdims=True)) * (xs - x_mean)).sum(-1) / ((xs - x_mean) ** 2).sum()
    slope = np.minimum(slope, -6.0) - 3.0  # always decay, plus extra roll-off
    edge = env[..., max(f_hi - 8, f_lo):f_hi].mean(-1)  # level just below the cutoff
    octs = np.log2(target_bins / kc)
    gain_offset = -9.0 + 6.0 * float(np.clip(strength, 0.0, 1.0))  # -9 dB .. -3 dB
    target_db = edge[..., None] + slope[..., None] * octs[None, None, :] + gain_offset
    src_env_db = env[..., src_bins]
    gain = 10.0 ** ((target_db - src_env_db) / 20.0)
    # Fade in over the first ~300 Hz above the cutoff to avoid a spectral step.
    ramp_len = max(2, int(round(300.0 / bin_hz)))
    ramp = np.clip((np.arange(len(target_bins)) + 1) / ramp_len, 0.0, 1.0)
    # Never synthesise above the energy actually present below the cutoff.
    gain = np.minimum(gain, 1.0) * ramp[None, None, :]
    hf = np.zeros_like(spec)
    hf[..., target_bins] = spec[..., src_bins] * gain.astype(np.float32)
    # Only fill where the original is essentially empty.
    existing = mag[..., target_bins]
    fill = np.clip(1.0 - existing / (np.abs(hf[..., target_bins]) + 1e-9), 0.0, 1.0)
    hf[..., target_bins] *= fill
    out = audio + stft.inverse(hf, audio.shape[1])
    return out.astype(np.float32)
