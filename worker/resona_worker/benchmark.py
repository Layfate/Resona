"""Performance benchmark for each processing stage on synthetic audio."""

from __future__ import annotations

import time

import numpy as np

from .dsp import bandwidth, declip, dehiss, limiter, loudness
from .dsp.resample import resample
from .protocol import log


def synthetic_music(seconds: float, sr: int = 44100, seed: int = 7) -> np.ndarray:
    """Stereo test signal: harmonic tones, percussive noise bursts and hiss."""
    rng = np.random.default_rng(seed)
    n = int(seconds * sr)
    t = np.arange(n) / sr
    sig = np.zeros((2, n), dtype=np.float64)
    for i, f0 in enumerate((110.0, 220.0, 330.0, 440.0, 660.0)):
        env = 0.5 + 0.5 * np.sin(2 * np.pi * (0.25 + 0.1 * i) * t)
        for h in range(1, 8):
            sig[i % 2] += env * np.sin(2 * np.pi * f0 * h * t + rng.uniform(0, 6.28)) / (h * 6)
    beats = (np.arange(n) % int(sr * 0.5)) < int(sr * 0.02)
    sig += 0.3 * rng.standard_normal((2, n)) * beats
    sig += 0.003 * rng.standard_normal((2, n))
    sig /= np.max(np.abs(sig)) * 1.05
    return sig.astype(np.float32)


def _time(fn) -> float:
    t = time.perf_counter()
    fn()
    return time.perf_counter() - t


def run(models_dir: str, device: str = "auto", seconds: float = 60.0) -> dict:
    sr = 44100
    audio = synthetic_music(seconds, sr)
    results: dict[str, dict] = {}

    def record(name: str, dt: float) -> None:
        results[name] = {"seconds": round(dt, 3), "realtime": round(seconds / dt, 1) if dt > 0 else None}
        log(f"{name}: {dt:.2f}s ({seconds / dt:.1f}x realtime)")

    record("loudness", _time(lambda: loudness.integrated_loudness(audio, sr)))
    record("truePeak", _time(lambda: loudness.true_peak(audio)))
    clipped = np.clip(audio * 1.6, -0.9, 0.9)
    record("declip", _time(lambda: declip.declip(clipped)))
    record("resample44to48", _time(lambda: resample(audio, sr, 48000)))
    prof = dehiss.estimate_noise_profile(audio, sr)
    record("dehiss", _time(lambda: dehiss.apply(audio, prof, 0.5)))
    lp = resample(resample(audio, sr, 32000), 32000, sr)
    record("bandwidthDetect", _time(lambda: bandwidth.detect_cutoff(lp, sr)))
    record("bandwidthExtend", _time(lambda: bandwidth.extend(lp, sr, 16000.0, 0.5)))
    record("limiter", _time(lambda: limiter.limit(audio * 2.0, sr, -1.0)))
    out: dict = {"audioSeconds": seconds, "sampleRate": sr, "channels": 2, "stages": results}
    try:
        from .models import registry
        from .models.deepfilternet import DeepFilterNet

        mdir = registry.require(models_dir, "deepfilternet3")
        model = DeepFilterNet(mdir, device=device)
        x48 = resample(audio, sr, 48000)
        model.enhance(x48[:, :48000])  # warm-up (session init, kernel selection)
        record(f"deepfilternet3[{model.device}]", _time(lambda: model.enhance(x48)))
        out["device"] = model.device
    except Exception as exc:
        log(f"DeepFilterNet3 benchmark skipped: {exc}", "warn")
    return out
