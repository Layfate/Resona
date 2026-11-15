"""Music-safe stationary noise reduction (spectral de-hiss).

A global noise profile is estimated from the quietest frames of the whole file;
each frame is then attenuated with a decision-directed Wiener gain
(Ephraim & Malah, 1984) that is

* linked across channels (identical gains on L/R – the stereo image is kept),
* limited by a gain floor (``max_reduction_db``) so noise is reduced, never gated,
* smoothed over time and frequency to avoid "musical noise".

This is classic DSP rather than machine learning, and it is the safest choice
for full-band music where speech-trained neural denoisers can damage
instruments.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter1d

from .stft import Stft

N_FFT = 2048
HOP = 512


def estimate_noise_profile(audio: np.ndarray, sr: int, quiet_fraction: float = 0.1) -> np.ndarray:
    """Per-bin noise power estimated from the quietest frames (channel-averaged)."""
    stft = Stft(N_FFT, HOP)
    n = audio.shape[1]
    step = sr * 30
    powers = []
    for a in range(0, n, step):
        spec = stft.forward(audio[:, a:a + step])
        powers.append(np.mean(np.abs(spec) ** 2, axis=0))  # [T, F]
    p = np.concatenate(powers, axis=0) if powers else np.zeros((1, N_FFT // 2 + 1))
    energy = p.sum(axis=1)
    active = energy > energy.max() * 1e-9 if energy.size else energy
    p_act = p[active] if np.any(active) else p
    e_act = p_act.sum(axis=1)
    k = max(1, int(len(e_act) * quiet_fraction))
    quiet = np.argsort(e_act)[:k]
    profile = np.median(p_act[quiet], axis=0)
    # Never exceed a low percentile of the overall spectrum – protects dense music
    # without silent passages from being treated as noise.
    cap = np.percentile(p_act, 20, axis=0)
    return np.minimum(profile, cap).astype(np.float32)


def apply(audio: np.ndarray, profile: np.ndarray, strength: float = 0.5,
          max_reduction_db: float = 12.0) -> np.ndarray:
    """Attenuate stationary noise. ``strength`` 0..1 scales the over-subtraction."""
    if strength <= 0:
        return audio
    stft = Stft(N_FFT, HOP)
    spec = stft.forward(audio)  # [C, T, F]
    power = np.mean(np.abs(spec) ** 2, axis=0)  # linked across channels
    noise = profile[None, :] * (0.5 + 1.5 * strength)  # over-subtraction 0.5..2.0
    g_min = 10.0 ** (-max_reduction_db * min(1.0, strength * 1.5) / 20.0)
    alpha = 0.96
    t_frames = power.shape[0]
    gains = np.empty_like(power)
    prev = np.zeros(power.shape[1], dtype=np.float32)
    nz = np.maximum(noise[0], 1e-20)
    for t in range(t_frames):
        gamma = power[t] / nz
        xi = alpha * prev / nz + (1.0 - alpha) * np.maximum(gamma - 1.0, 0.0)
        g = xi / (1.0 + xi)
        g = np.maximum(g, g_min)
        gains[t] = g
        prev = (g * g) * power[t]
    # Smooth across frequency (3 bins) and time (3 frames) to suppress musical noise.
    gains = uniform_filter1d(gains, size=3, axis=1, mode="nearest")
    gains = uniform_filter1d(gains, size=3, axis=0, mode="nearest")
    out = stft.inverse(spec * gains[None, :, :], audio.shape[1])
    return out.astype(np.float32)
