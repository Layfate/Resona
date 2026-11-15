"""Built-in enhancement presets (mirrored in the UI, see ``src/lib/presets.ts``)."""

from __future__ import annotations

import copy

DEFAULT_STAGES: dict = {
    "declip": {"enabled": False},
    "denoise": {"enabled": False, "engine": "spectral", "strength": 0.5},
    "vocal": {"enabled": False, "amountDb": 3.0},
    "bandwidth": {"enabled": False, "strength": 0.5},
}

PRESETS: dict[str, dict] = {
    # Full mixes: protect instruments; repair, gently de-hiss, restore "air".
    "music": {
        "declip": {"enabled": True},
        "denoise": {"enabled": True, "engine": "spectral", "strength": 0.35},
        "vocal": {"enabled": False, "amountDb": 2.0},
        "bandwidth": {"enabled": True, "strength": 0.5},
    },
    # Speech, podcasts, a cappella vocals: full neural denoising.
    "vocals": {
        "declip": {"enabled": True},
        "denoise": {"enabled": True, "engine": "dfn", "strength": 0.85},
        "vocal": {"enabled": False, "amountDb": 3.0},
        "bandwidth": {"enabled": True, "strength": 0.4},
    },
    # Old / degraded recordings: stronger repair and noise reduction.
    "restoration": {
        "declip": {"enabled": True},
        "denoise": {"enabled": True, "engine": "spectral", "strength": 0.7},
        "vocal": {"enabled": True, "amountDb": 2.0},
        "bandwidth": {"enabled": True, "strength": 0.65},
    },
}


def stages_for(preset: str, overrides: dict | None = None) -> dict:
    base = copy.deepcopy(DEFAULT_STAGES)
    for key, val in PRESETS.get(preset, {}).items():
        base[key].update(val)
    for key, val in (overrides or {}).items():
        if key in base and isinstance(val, dict):
            base[key].update(val)
    return base


def dfn_atten_limit(strength: float) -> float:
    """Map 0..1 strength to a DeepFilterNet attenuation limit in dB (6..100)."""
    s = min(max(strength, 0.0), 1.0)
    if s >= 0.99:
        return 100.0  # no limit
    return 6.0 + s * 30.0
