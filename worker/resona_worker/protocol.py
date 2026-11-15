"""Newline-delimited JSON protocol shared with the Rust backend.

Every message is a single JSON object on its own line with a ``type`` field:

* ``progress`` – ``{"type": "progress", "stage": str, "progress": float, "message": str}``
* ``log``      – ``{"type": "log", "level": str, "message": str}``
* ``result``   – ``{"type": "result", "data": {...}}`` (exactly once on success)
* ``error``    – ``{"type": "error", "code": str, "message": str}`` (exactly once on failure)

Only this module writes to the real stdout. ``install_stdout_guard`` redirects
``sys.stdout`` to stderr so that stray ``print`` calls from third-party
libraries cannot break the protocol.
"""

from __future__ import annotations

import json
import math
import os
import sys
import threading
import time
from dataclasses import dataclass, field
from typing import Any, TextIO

_lock = threading.Lock()
_out: TextIO = sys.stdout


def install_stdout_guard() -> None:
    """Route accidental prints to stderr; keep the protocol stream clean."""
    global _out
    _out = sys.stdout
    sys.stdout = sys.stderr


def _sanitize(value: Any) -> Any:
    """Make values JSON-safe (NaN/inf are not valid JSON)."""
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return None
        return value
    if isinstance(value, dict):
        return {str(k): _sanitize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitize(v) for v in value]
    if hasattr(value, "tolist"):  # numpy scalars / arrays
        return _sanitize(value.tolist())
    return value


def emit(msg_type: str, **payload: Any) -> None:
    line = json.dumps(_sanitize({"type": msg_type, **payload}), separators=(",", ":"))
    with _lock:
        _out.write(line + "\n")
        _out.flush()


def log(message: str, level: str = "info") -> None:
    emit("log", level=level, message=message)
    if os.environ.get("RESONA_DEBUG"):
        print(f"[{level}] {message}", file=sys.stderr)


def result(data: dict[str, Any]) -> None:
    emit("result", data=data)


def error(code: str, message: str) -> None:
    emit("error", code=code, message=message)


class WorkerError(Exception):
    """An expected, user-facing failure with a stable error code."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Progress:
    """Maps per-stage progress onto one monotonically increasing 0..1 value.

    Stages are registered with relative weights up-front; ``update`` reports a
    fraction within the current stage. Messages are rate limited to keep IPC
    overhead negligible.
    """

    weights: dict[str, float]
    min_interval: float = 0.1
    _order: list[str] = field(default_factory=list)
    _done: float = 0.0
    _current: str | None = None
    _last_emit: float = 0.0
    _last_value: float = 0.0

    def __post_init__(self) -> None:
        total = sum(self.weights.values()) or 1.0
        self.weights = {k: v / total for k, v in self.weights.items()}
        self._order = list(self.weights)

    def start(self, stage: str, message: str = "") -> None:
        if self._current is not None and self._current in self.weights:
            self._done += self.weights[self._current]
        self._current = stage
        self._emit(0.0, message or stage, force=True)

    def update(self, fraction: float, message: str = "") -> None:
        self._emit(min(max(fraction, 0.0), 1.0), message)

    def finish(self) -> None:
        self._current = None
        self._done = 1.0
        emit("progress", stage="done", progress=1.0, message="Done")

    def _emit(self, fraction: float, message: str, force: bool = False) -> None:
        if self._current is None:
            return
        weight = self.weights.get(self._current, 0.0)
        value = min(self._done + weight * fraction, 0.999)
        value = max(value, self._last_value)  # never go backwards
        now = time.monotonic()
        if not force and now - self._last_emit < self.min_interval:
            return
        self._last_emit = now
        self._last_value = value
        emit("progress", stage=self._current, progress=round(value, 4), message=message)
