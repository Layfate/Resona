"""Compute-device discovery and ONNX Runtime execution-provider selection."""

from __future__ import annotations

import os
import platform
from typing import Any

from .protocol import log

_PROVIDER_FOR = {
    "cuda": "CUDAExecutionProvider",
    "directml": "DmlExecutionProvider",
    "coreml": "CoreMLExecutionProvider",
    "rocm": "ROCMExecutionProvider",
    "cpu": "CPUExecutionProvider",
}
# "auto" policy. Measured with DeepFilterNet3 (small recurrent model, 120 s stereo):
#   CPU 31x realtime, CUDA (RTX 4060) 30x, DirectML 2x. GPUs only help large models,
#   so "auto" means CPU unless a model explicitly benefits from a GPU.
_AUTO_ORDER_GPU = ("cuda", "rocm", "directml", "coreml", "cpu")
_preloaded = False


def _ort():
    import onnxruntime as ort

    global _preloaded
    if not _preloaded:
        _preloaded = True
        # onnxruntime-gpu >= 1.21 can load CUDA/cuDNN from the nvidia-* pip wheels.
        if hasattr(ort, "preload_dlls") and "CUDAExecutionProvider" in ort.get_available_providers():
            try:
                ort.preload_dlls()
            except Exception as exc:  # pragma: no cover - depends on local CUDA install
                log(f"CUDA library preload failed: {exc}", "warn")
    return ort


def onnx_devices() -> list[str]:
    try:
        avail = set(_ort().get_available_providers())
    except Exception:
        return []
    return [name for name, prov in _PROVIDER_FOR.items() if prov in avail]


def torch_info() -> dict[str, Any] | None:
    try:
        import torch  # noqa: F401
    except Exception:
        return None
    import torch

    info: dict[str, Any] = {"version": torch.__version__, "cuda": False, "mps": False, "devices": []}
    try:
        if torch.cuda.is_available():
            info["cuda"] = True
            info["hip"] = bool(getattr(torch.version, "hip", None))
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                info["devices"].append({"index": i, "name": p.name, "memoryMb": p.total_memory // (1 << 20)})
    except Exception:
        pass
    try:
        info["mps"] = bool(torch.backends.mps.is_available())
    except Exception:
        pass
    return info


def describe() -> dict[str, Any]:
    ort_version = None
    try:
        ort_version = _ort().__version__
    except Exception:
        pass
    return {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "cpuCount": os.cpu_count(),
        "onnxruntime": ort_version,
        "onnxDevices": onnx_devices(),
        "torch": torch_info(),
    }


def resolve_onnx(device: str, prefer_gpu: bool = False) -> tuple[list, str]:
    """Return ``(providers, resolved_device)`` for an ONNX Runtime session.

    Unknown or unavailable devices fall back to CPU instead of failing.
    """
    available = onnx_devices()
    device = (device or "auto").lower()
    if device == "auto":
        choice = next((d for d in _AUTO_ORDER_GPU if d in available), "cpu") if prefer_gpu else "cpu"
    elif device in available:
        choice = device
    else:
        if device != "cpu":
            log(f"Requested device '{device}' is not available; falling back to CPU", "warn")
        choice = "cpu"
    providers: list = []
    if choice == "cuda":
        providers.append(("CUDAExecutionProvider", {"cudnn_conv_algo_search": "HEURISTIC"}))
    elif choice != "cpu":
        providers.append(_PROVIDER_FOR[choice])
    providers.append("CPUExecutionProvider")
    return providers, choice
