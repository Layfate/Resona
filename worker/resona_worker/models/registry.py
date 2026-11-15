"""Model registry: provenance, licensing, download and integrity verification.

Every downloadable model is pinned to an immutable URL (a specific git commit)
and a SHA-256 digest of the archive *and* of each extracted file. Nothing is
executed from downloaded archives – only data files with an expected name are
extracted, and paths are validated against traversal.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import tarfile
import tempfile
import time
import urllib.request
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .. import __version__
from ..protocol import WorkerError, log


@dataclass(frozen=True)
class ModelSpec:
    id: str
    name: str
    version: str
    tasks: tuple[str, ...]
    engine: str  # "onnx" | "torch"
    license: str
    license_url: str
    source: str
    paper: str
    url: str
    sha256: str
    size: int
    archive: str  # "tar.gz" | "file"
    files: dict[str, str] = field(default_factory=dict)  # archive member -> sha256
    sample_rate: int = 48000
    description: str = ""
    limitations: str = ""
    experimental: bool = False


DEEPFILTERNET3 = ModelSpec(
    id="deepfilternet3",
    name="DeepFilterNet3",
    version="3.0 (2023-05-23)",
    tasks=("denoise", "vocal"),
    engine="onnx",
    license="MIT OR Apache-2.0",
    license_url="https://github.com/Rikorose/DeepFilterNet#license",
    source="https://github.com/Rikorose/DeepFilterNet",
    paper="Schröter et al., “DeepFilterNet: Perceptually Motivated Real-Time Speech Enhancement”, Interspeech 2023",
    url=(
        "https://github.com/Rikorose/DeepFilterNet/raw/"
        "84d57ec2c08fe08e68a13fb32a58cd7092060a0f/models/DeepFilterNet3_onnx.tar.gz"
    ),
    sha256="c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616",
    size=7983136,
    archive="tar.gz",
    files={
        "tmp/export/enc.onnx": "7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916",
        "tmp/export/erb_dec.onnx": "ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895",
        "tmp/export/df_dec.onnx": "23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a",
        "tmp/export/config.ini": "415eb925d44990d938fb739f514aa3662c1ec0ea836cff044fa1291b82cb4290",
    },
    sample_rate=48000,
    description=(
        "Full-band (48 kHz) neural noise suppression using ERB-band gains plus deep filtering. "
        "Removes background noise, hiss, hum and room noise from speech and vocals in real time."
    ),
    limitations=(
        "Trained on speech. On full mixes it treats much of the instrumentation as noise, so Resona uses it "
        "with an attenuation limit for music, or to isolate vocals for clarity enhancement."
    ),
)

REGISTRY: dict[str, ModelSpec] = {m.id: m for m in (DEEPFILTERNET3,)}

MANIFEST = "resona-model.json"


def get(model_id: str) -> ModelSpec:
    try:
        return REGISTRY[model_id]
    except KeyError as exc:
        raise WorkerError("unknown_model", f"Unknown model: {model_id}") from exc


def model_dir(models_root: str | os.PathLike, model_id: str) -> Path:
    return Path(models_root) / model_id


def sha256_file(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def status(models_root: str | os.PathLike, spec: ModelSpec, deep: bool = False) -> dict:
    """Installed / verified state of a model (``deep`` re-hashes every file)."""
    d = model_dir(models_root, spec.id)
    manifest = d / MANIFEST
    installed = manifest.is_file() and all((d / Path(m).name).is_file() for m in spec.files)
    verified = None
    if installed and deep:
        verified = all(sha256_file(d / Path(m).name) == digest for m, digest in spec.files.items())
    info = asdict(spec)
    info["tasks"] = list(spec.tasks)
    info.pop("files")
    info.update({"installed": installed, "verified": verified, "path": str(d)})
    return info


def list_models(models_root: str | os.PathLike, deep: bool = False) -> list[dict]:
    return [status(models_root, spec, deep) for spec in REGISTRY.values()]


def _download(url: str, dest: Path, expected_size: int, on_progress: Callable[[float], None] | None) -> None:
    req = urllib.request.Request(url, headers={"User-Agent": f"Resona/{__version__}"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(dest, "wb") as out:
        total = int(resp.headers.get("Content-Length") or expected_size or 0)
        done = 0
        last = 0.0
        while True:
            block = resp.read(1 << 16)
            if not block:
                break
            out.write(block)
            done += len(block)
            now = time.monotonic()
            if on_progress and total and now - last > 0.1:
                on_progress(min(done / total, 1.0))
                last = now


def _safe_extract(archive: Path, spec: ModelSpec, target: Path) -> None:
    with tarfile.open(archive, "r:gz") as tar:
        members = {m.name: m for m in tar.getmembers()}
        for name, digest in spec.files.items():
            m = members.get(name)
            if m is None or not m.isfile():
                raise WorkerError("model_corrupt", f"Archive is missing {name}")
            fh = tar.extractfile(m)
            if fh is None:
                raise WorkerError("model_corrupt", f"Cannot read {name}")
            data = fh.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise WorkerError("model_corrupt", f"Checksum mismatch for {name}")
            out = target / Path(name).name  # flatten; never trust archive paths
            out.write_bytes(data)


def install(models_root: str | os.PathLike, model_id: str,
            on_progress: Callable[[float], None] | None = None) -> dict:
    spec = get(model_id)
    root = Path(models_root)
    root.mkdir(parents=True, exist_ok=True)
    final = model_dir(root, spec.id)
    with tempfile.TemporaryDirectory(dir=root, prefix=f".{spec.id}-") as tmp:
        tmp_p = Path(tmp)
        archive = tmp_p / "download"
        log(f"Downloading {spec.name} from {spec.url}")
        try:
            _download(spec.url, archive, spec.size, on_progress)
        except WorkerError:
            raise
        except Exception as exc:
            raise WorkerError("download_failed", f"Could not download {spec.name}: {exc}") from exc
        digest = sha256_file(archive)
        if digest != spec.sha256:
            raise WorkerError("model_corrupt", f"Checksum mismatch for {spec.name} (got {digest[:12]}…)")
        staging = tmp_p / "staging"
        staging.mkdir()
        if spec.archive == "tar.gz":
            _safe_extract(archive, spec, staging)
        else:
            shutil.copy2(archive, staging / Path(next(iter(spec.files))).name)
        (staging / MANIFEST).write_text(json.dumps({
            "id": spec.id, "version": spec.version, "sha256": spec.sha256, "url": spec.url,
            "license": spec.license, "installedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }, indent=2), encoding="utf-8")
        if final.exists():
            shutil.rmtree(final)
        os.replace(staging, final)
    return status(root, spec, deep=True)


def install_from_archive(models_root: str | os.PathLike, model_id: str, archive_path: str) -> dict:
    """Install from a local archive (offline installs, CI caches). Still verified."""
    spec = get(model_id)
    root = Path(models_root)
    root.mkdir(parents=True, exist_ok=True)
    if sha256_file(Path(archive_path)) != spec.sha256:
        raise WorkerError("model_corrupt", "Archive checksum does not match the registry.")
    final = model_dir(root, spec.id)
    with tempfile.TemporaryDirectory(dir=root, prefix=f".{spec.id}-") as tmp:
        staging = Path(tmp) / "staging"
        staging.mkdir()
        _safe_extract(Path(archive_path), spec, staging)
        (staging / MANIFEST).write_text(json.dumps({"id": spec.id, "sha256": spec.sha256}), encoding="utf-8")
        if final.exists():
            shutil.rmtree(final)
        os.replace(staging, final)
    return status(root, spec, deep=True)


def remove(models_root: str | os.PathLike, model_id: str) -> None:
    d = model_dir(models_root, get(model_id).id)
    if d.exists():
        shutil.rmtree(d)


def require(models_root: str | os.PathLike, model_id: str) -> Path:
    spec = get(model_id)
    st = status(models_root, spec)
    if not st["installed"]:
        raise WorkerError("model_missing", f"{spec.name} is not installed. Download it from the Models panel.")
    return model_dir(models_root, spec.id)


