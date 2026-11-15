"""Chunked processing with context padding and seamless crossfades.

Long recordings are split into cores of ``chunk`` samples. Each core is
processed together with ``context`` extra samples on both sides (so stateful
models such as recurrent networks can warm up), then only the core – plus a
short linear crossfade region – is kept. Adjacent crossfade ramps are
amplitude-complementary, so identical outputs reconstruct the signal exactly.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np

ChunkFn = Callable[[np.ndarray], np.ndarray]


def plan_chunks(n: int, chunk: int, context: int) -> list[tuple[int, int, int, int]]:
    """Return ``(core_start, core_end, pad_start, pad_end)`` tuples covering ``[0, n)``."""
    if n <= chunk + context:
        return [(0, n, 0, n)]
    k = int(np.ceil(n / chunk))
    bounds = np.linspace(0, n, k + 1).round().astype(int)
    out = []
    for i in range(k):
        a, b = int(bounds[i]), int(bounds[i + 1])
        out.append((a, b, max(0, a - context), min(n, b + context)))
    return out


def process_chunked(
    audio: np.ndarray,
    fn: ChunkFn,
    chunk: int,
    context: int,
    fade: int,
    on_progress: Callable[[float], None] | None = None,
) -> np.ndarray:
    """Apply ``fn`` (``[C, M] -> [C, M]``, length preserving) chunk by chunk."""
    n = audio.shape[-1]
    fade = int(min(fade, context))
    plan = plan_chunks(n, chunk, context)
    if len(plan) == 1:
        out = fn(audio)
        if on_progress:
            on_progress(1.0)
        return _checked(out, audio.shape)
    out = np.zeros(audio.shape, dtype=np.float32)
    half = fade // 2
    for idx, (a, b, pa, pb) in enumerate(plan):
        y = _checked(fn(audio[:, pa:pb]), (audio.shape[0], pb - pa))
        # Weight window in absolute coordinates: ramps centred on core boundaries.
        lo = a - half if idx > 0 else a
        hi = b + (fade - half) if idx < len(plan) - 1 else b
        lo, hi = max(lo, pa), min(hi, pb)
        w = np.ones(hi - lo, dtype=np.float32)
        if idx > 0 and fade > 0:
            ramp = (np.arange(fade, dtype=np.float32) + 0.5) / fade
            w[:fade] = ramp
        if idx < len(plan) - 1 and fade > 0:
            ramp = 1.0 - (np.arange(fade, dtype=np.float32) + 0.5) / fade
            w[-fade:] = ramp if w.size >= fade else ramp[-w.size:]
        out[:, lo:hi] += y[:, lo - pa:hi - pa] * w[None, :]
        if on_progress:
            on_progress((idx + 1) / len(plan))
    return out


def _checked(y: np.ndarray, shape: tuple[int, ...]) -> np.ndarray:
    if y.shape != tuple(shape):
        raise ValueError(f"chunk function changed shape {shape} -> {y.shape}")
    return y.astype(np.float32, copy=False)
