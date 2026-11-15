"""Minimal STFT / ISTFT with weighted overlap-add (perfect reconstruction)."""

from __future__ import annotations

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view


def sqrt_hann(n: int) -> np.ndarray:
    # Periodic Hann; its square root satisfies the WOLA constraint at hop = n/2 and n/4.
    return np.sqrt(0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(n) / n)).astype(np.float32)


class Stft:
    def __init__(self, n_fft: int = 2048, hop: int = 512):
        self.n_fft = n_fft
        self.hop = hop
        self.window = sqrt_hann(n_fft)
        # WOLA normalisation: sum of squared windows across overlapping frames.
        self._norm = float(np.sum(self.window ** 2) / hop)

    @property
    def bins(self) -> int:
        return self.n_fft // 2 + 1

    def pad_amount(self, n: int) -> tuple[int, int]:
        left = self.n_fft - self.hop
        total = n + 2 * left
        right = left + (-total) % self.hop
        return left, right

    def forward(self, x: np.ndarray) -> np.ndarray:
        """``[..., N] -> [..., T, F]`` complex64."""
        left, right = self.pad_amount(x.shape[-1])
        pad = [(0, 0)] * (x.ndim - 1) + [(left, right)]
        xp = np.pad(x, pad)
        frames = sliding_window_view(xp, self.n_fft, axis=-1)[..., :: self.hop, :]
        return np.fft.rfft(frames * self.window, axis=-1).astype(np.complex64)

    def inverse(self, spec: np.ndarray, n: int) -> np.ndarray:
        """``[..., T, F] -> [..., n]`` float32."""
        frames = np.fft.irfft(spec, n=self.n_fft, axis=-1).astype(np.float32) * self.window
        t = frames.shape[-2]
        total = (t - 1) * self.hop + self.n_fft
        lead = frames.shape[:-2]
        out = np.zeros(lead + (total,), dtype=np.float32)
        r = self.n_fft // self.hop
        # Overlap-add in r interleaved passes; each pass has non-overlapping frames.
        for k in range(r):
            sel = frames[..., k::r, :]
            m = sel.shape[-2]
            if m == 0:
                continue
            start = k * self.hop
            seg = out[..., start:start + m * self.n_fft]
            seg_len = seg.shape[-1]
            flat = sel.reshape(lead + (m * self.n_fft,))[..., :seg_len]
            seg += flat
        out /= self._norm
        left, _ = self.pad_amount(n)
        return out[..., left:left + n]
