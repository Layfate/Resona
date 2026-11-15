"""File diagnosis: clipping, bandwidth, loudness, noise floor and a preset hint."""

from __future__ import annotations

import numpy as np

from .dsp import bandwidth, declip, loudness

SPECTRUM_POINTS = 160


def spectrum_summary(audio: np.ndarray, sr: int, points: int = SPECTRUM_POINTS) -> dict:
    """Long-term spectrum resampled onto a log-frequency axis (20 Hz .. Nyquist)."""
    ldb, freqs = bandwidth.ltas_db(audio, sr, n_fft=4096)
    nyq = sr / 2
    axis = np.geomspace(20.0, nyq, points)
    vals = np.interp(axis, freqs, ldb)
    return {"freqs": np.round(axis, 1).tolist(), "db": np.round(vals, 2).tolist()}


def peaks(audio: np.ndarray, points: int = 2400) -> list[float]:
    """Max-abs envelope (all channels) in ``points`` buckets for waveform display."""
    n = audio.shape[1]
    if n == 0:
        return []
    points = int(min(points, n))
    edges = np.linspace(0, n, points + 1).astype(np.int64)
    env = np.max(np.abs(audio), axis=0)
    out = np.maximum.reduceat(env, edges[:-1])
    return np.round(out.astype(np.float64), 4).tolist()


def noise_floor_db(audio: np.ndarray, sr: int) -> float | None:
    """Noise floor (dBFS): RMS of the quietest 10 % of 50 ms windows.

    Only meaningful when the recording has genuinely quiet passages (at least
    20 dB below its typical level); dense music without pauses returns ``None``
    instead of mistaking the music itself for noise.
    """
    mono = audio.mean(axis=0)
    w = max(1, int(0.05 * sr))
    n = len(mono) // w
    if n < 20:
        return None
    rms = np.sqrt(np.mean(mono[: n * w].reshape(n, w) ** 2, axis=1))
    rms = rms[rms > 1e-6]  # ignore digital silence
    if rms.size < 20:
        return None
    quiet = float(np.percentile(rms, 10))
    typical = float(np.median(rms))
    if typical <= 0 or 20 * np.log10(typical / max(quiet, 1e-12)) < 20.0:
        return None
    return float(20 * np.log10(quiet))


def analyze(audio: np.ndarray, sr: int) -> dict:
    clip = declip.detect(audio)
    bw = bandwidth.detect_cutoff(audio, sr)
    lufs = loudness.integrated_loudness(audio, sr)
    tp = loudness.true_peak(audio)
    nf = noise_floor_db(audio, sr)
    hints = []
    if clip.is_clipped:
        hints.append("clipping")
    if bw["bandLimited"]:
        hints.append("band_limited")
    if nf is not None and nf > -55:
        hints.append("noisy")
    if audio.shape[0] == 1:
        hints.append("mono")
    if nf is not None and nf > -45 and bw["bandLimited"]:
        preset = "restoration"
    else:
        preset = "music"
    return {
        "clipping": clip.to_dict(),
        "bandwidth": bw,
        "loudnessLufs": lufs,
        "truePeakDbtp": loudness.to_db(tp),
        "noiseFloorDb": nf,
        "spectrum": spectrum_summary(audio, sr),
        "peaks": peaks(audio),
        "hints": hints,
        "suggestedPreset": preset,
    }
