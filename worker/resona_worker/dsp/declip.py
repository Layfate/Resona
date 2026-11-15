"""Clipping detection and reconstruction.

Clipped regions are re-synthesised by least-squares autoregressive (AR)
interpolation (Janssen et al., 1986): an AR model is fitted to the clean
samples around a clipped run and the missing samples are chosen to minimise
the model's prediction error. The result is then projected onto the
"consistent" set – a reconstructed sample must lie beyond the clipping level
with the same polarity as the clipped original – and the procedure is iterated.

This genuinely restores the waveform peaks (it does not just soften them), but
like every declipper it can only *estimate* what was lost. Very heavy clipping
(long runs, >~2 ms) is reconstructed less accurately.
"""

from __future__ import annotations

import warnings
from collections.abc import Callable
from dataclasses import dataclass

import numpy as np
from scipy.linalg import LinAlgError, LinAlgWarning, solve


@dataclass
class ClipStats:
    clipped_fraction: float  # fraction of samples flagged as clipped
    runs: int
    level_pos: float
    level_neg: float
    longest_run: int

    @property
    def is_clipped(self) -> bool:
        return self.clipped_fraction > 1e-5 and self.runs >= 10

    def to_dict(self) -> dict:
        return {
            "clippedFraction": self.clipped_fraction,
            "runs": self.runs,
            "levelPos": self.level_pos,
            "levelNeg": self.level_neg,
            "longestRun": self.longest_run,
            "isClipped": self.is_clipped,
        }


def _runs(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Start/end (exclusive) indices of True runs."""
    if not mask.any():
        return np.zeros(0, dtype=np.int64), np.zeros(0, dtype=np.int64)
    d = np.diff(np.concatenate(([0], mask.view(np.int8), [0])))
    return np.flatnonzero(d == 1), np.flatnonzero(d == -1)


def clip_mask(x: np.ndarray, tolerance: float = 0.998, min_run: int = 2) -> tuple[np.ndarray, float, float]:
    """Flag samples at the extreme levels that form runs of >= ``min_run`` samples."""
    hi = float(x.max()) if x.size else 0.0
    lo = float(x.min()) if x.size else 0.0
    mask = np.zeros(x.shape, dtype=bool)
    if hi > 1e-4:
        mask |= x >= hi * tolerance
    if lo < -1e-4:
        mask |= x <= lo * tolerance
    starts, ends = _runs(mask)
    short = (ends - starts) < min_run
    for s, e in zip(starts[short], ends[short], strict=False):
        mask[s:e] = False
    return mask, hi * tolerance, lo * tolerance


def detect(audio: np.ndarray) -> ClipStats:
    total = 0
    runs = 0
    longest = 0
    pos, neg = 0.0, 0.0
    for ch in audio:
        mask, hi, lo = clip_mask(ch)
        s, e = _runs(mask)
        total += int(mask.sum())
        runs += len(s)
        if len(s):
            longest = max(longest, int((e - s).max()))
        pos, neg = max(pos, hi), min(neg, lo)
    frac = total / max(audio.size, 1)
    return ClipStats(frac, runs, pos, neg, longest)


def _ar_coeffs(seg: np.ndarray, order: int) -> np.ndarray | None:
    """Least-squares (covariance method) AR fit; returns [1, a1..ap]."""
    if seg.size <= 2 * order:
        return None
    X = np.lib.stride_tricks.sliding_window_view(seg, order + 1)[:, ::-1]  # [x_t, x_{t-1}, ...]
    y = X[:, 0]
    A = X[:, 1:]
    try:
        coef, *_ = np.linalg.lstsq(A, -y, rcond=None)
    except LinAlgError:
        return None
    return np.concatenate(([1.0], coef))


def _interpolate(win: np.ndarray, unknown: np.ndarray, a: np.ndarray) -> np.ndarray | None:
    """Solve for ``win[unknown]`` minimising the AR prediction error.

    Only the prediction-error rows that touch an unknown sample matter, so the
    problem is cropped to ``[first_unknown - p, last_unknown + p]``.
    """
    p = len(a) - 1
    idx_u = np.flatnonzero(unknown)
    if idx_u.size == 0:
        return np.zeros(0)
    lo = max(0, int(idx_u[0]) - p)
    hi = min(len(win), int(idx_u[-1]) + p + 1)
    w = win[lo:hi]
    u = unknown[lo:hi]
    m = len(w)
    rows = m - p
    if rows <= 0:
        return None
    E = np.zeros((rows, m))
    r = np.arange(rows)
    for k in range(p + 1):
        E[r, r + p - k] = a[k]
    Eu = E[:, u]
    Ek = E[:, ~u]
    rhs = -Eu.T @ (Ek @ w[~u])
    lhs = Eu.T @ Eu
    # Tiny ridge term only; stronger regularisation measurably biases the estimate.
    lhs += np.eye(lhs.shape[0]) * (1e-12 * (np.trace(lhs) / lhs.shape[0] + 1.0))
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", LinAlgWarning)
            return solve(lhs, rhs, assume_a="pos")
    except (LinAlgError, ValueError):
        return None


def declip_channel(x: np.ndarray, order: int = 32, iterations: int = 4, max_run: int = 600,
                   max_overshoot: float = 3.0,
                   on_progress: Callable[[float], None] | None = None) -> tuple[np.ndarray, int]:
    """Repair clipped runs in one channel; returns (audio, repaired sample count).

    ``max_overshoot`` bounds a plausible estimate to that multiple of the clip
    level (3.0 ≈ +9.5 dB). Near-unstable AR models occasionally interpolate a
    run into a spike far beyond any real peak; such an estimate is discarded
    and the last consistent one (or the clipped original) is kept.
    """
    mask, hi, lo = clip_mask(x)
    starts, ends = _runs(mask)
    if len(starts) == 0:
        return x, 0
    y = x.astype(np.float64).copy()
    # Group runs separated by less than 2*order samples into one joint problem.
    groups: list[tuple[int, int]] = []
    gs, ge = int(starts[0]), int(ends[0])
    for s, e in zip(starts[1:], ends[1:], strict=False):
        if s - ge < 2 * order:
            ge = int(e)
        else:
            groups.append((gs, ge))
            gs, ge = int(s), int(e)
    groups.append((gs, ge))
    repaired = 0
    n = len(x)
    lim = 4.0 * max(abs(hi), abs(lo))
    for gi, (s, e) in enumerate(groups):
        if on_progress and gi % 200 == 0:
            on_progress(gi / len(groups))
        span = e - s
        if span > max_run:
            continue  # too long to estimate reliably; leave untouched
        ctx = max(4 * order, min(2 * span, 1024))
        a0, b0 = max(0, s - ctx), min(n, e + ctx)
        win = y[a0:b0].copy()
        orig = x[a0:b0]
        unknown = mask[a0:b0].copy()
        if unknown.all():
            continue
        # AR model from the clean context on either side (Janssen initial estimate).
        parts = [seg for seg in (win[: s - a0], win[e - a0:]) if seg.size > 2 * order + 8]
        coefs = [c for c in (_ar_coeffs(seg, order) for seg in parts) if c is not None]
        if not coefs:
            continue
        a = np.mean(coefs, axis=0)
        bound = max_overshoot * max(abs(hi), abs(lo))
        free = unknown.copy()
        ok = False
        for it in range(iterations):
            est = _interpolate(win, free, a)
            if est is None or not np.all(np.isfinite(est)) or np.max(np.abs(est)) > bound:
                break
            win[free] = est
            ok = True
            # Active-set consistency: samples that came out inside the clip range
            # are pinned to the clip level and removed from the free set.
            viol = free & (((orig > 0) & (win < hi)) | ((orig < 0) & (win > lo)))
            if not viol.any():
                break
            win[viol & (orig > 0)] = hi
            win[viol & (orig < 0)] = lo
            free &= ~viol
            if not free.any():
                break
            if it == 0:
                # Refine the AR model on the whole window including the estimate.
                refined = _ar_coeffs(win, order)
                if refined is not None:
                    a = refined
        if ok:
            y[a0:b0][unknown] = np.clip(win[unknown], -lim, lim)
            repaired += int(unknown.sum())
    if on_progress:
        on_progress(1.0)
    return y.astype(np.float32), repaired


def declip(audio: np.ndarray, on_progress: Callable[[float], None] | None = None) -> tuple[np.ndarray, int]:
    out = np.empty_like(audio)
    total = 0
    c = audio.shape[0]
    for i in range(c):
        cb = (lambda f, i=i: on_progress((i + f) / c)) if on_progress else None
        out[i], r = declip_channel(audio[i], on_progress=cb)
        total += r
    return out, total
