import os
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

FIXTURES = Path(__file__).parent / "fixtures"


def models_dir() -> str | None:
    """Directory containing an installed DeepFilterNet3 (via RESONA_MODELS_DIR)."""
    d = os.environ.get("RESONA_MODELS_DIR")
    if d and (Path(d) / "deepfilternet3" / "enc.onnx").is_file():
        return d
    return None


requires_dfn = pytest.mark.skipif(models_dir() is None, reason="DeepFilterNet3 not installed (set RESONA_MODELS_DIR)")


def sine(freq: float, seconds: float, sr: int, amp: float = 1.0, channels: int = 1) -> np.ndarray:
    t = np.arange(int(seconds * sr)) / sr
    x = (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    return np.tile(x, (channels, 1))


def snr_db(ref: np.ndarray, est: np.ndarray) -> float:
    err = ref - est
    return float(10 * np.log10(np.sum(ref.astype(np.float64) ** 2) / max(np.sum(err.astype(np.float64) ** 2), 1e-20)))
