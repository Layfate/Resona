import hashlib
import io
import tarfile
from dataclasses import replace

import pytest

from resona_worker.models import registry
from resona_worker.protocol import WorkerError


def _make_archive(tmp_path, members: dict[str, bytes]):
    p = tmp_path / "model.tar.gz"
    with tarfile.open(p, "w:gz") as tar:
        for name, data in members.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return p


def _spec_for(archive, files):
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    return replace(registry.DEEPFILTERNET3, id="testmodel", sha256=digest,
                   files={k: hashlib.sha256(v).hexdigest() for k, v in files.items()})


def test_install_verify_remove(tmp_path, monkeypatch):
    files = {"tmp/export/a.onnx": b"aaa", "tmp/export/config.ini": b"[df]\n"}
    archive = _make_archive(tmp_path, files)
    spec = _spec_for(archive, files)
    monkeypatch.setitem(registry.REGISTRY, spec.id, spec)
    root = tmp_path / "models"
    st = registry.install_from_archive(root, spec.id, str(archive))
    assert st["installed"] and st["verified"]
    assert (root / "testmodel" / "a.onnx").read_bytes() == b"aaa"
    # Tampering is detected by deep verification.
    (root / "testmodel" / "a.onnx").write_bytes(b"evil")
    assert registry.status(root, spec, deep=True)["verified"] is False
    registry.remove(root, spec.id)
    assert not registry.status(root, spec)["installed"]


def test_rejects_wrong_archive_checksum(tmp_path, monkeypatch):
    files = {"tmp/export/a.onnx": b"aaa"}
    archive = _make_archive(tmp_path, files)
    spec = replace(_spec_for(archive, files), sha256="0" * 64)
    monkeypatch.setitem(registry.REGISTRY, spec.id, spec)
    with pytest.raises(WorkerError) as e:
        registry.install_from_archive(tmp_path / "m", spec.id, str(archive))
    assert e.value.code == "model_corrupt"


def test_rejects_tampered_member_and_ignores_traversal(tmp_path, monkeypatch):
    good = {"tmp/export/a.onnx": b"aaa"}
    archive = _make_archive(tmp_path, {"tmp/export/a.onnx": b"bad", "../../escape.txt": b"x"})
    spec = replace(_spec_for(archive, good))
    monkeypatch.setitem(registry.REGISTRY, spec.id, spec)
    with pytest.raises(WorkerError):
        registry.install_from_archive(tmp_path / "m", spec.id, str(archive))
    assert not (tmp_path.parent / "escape.txt").exists()


def test_registry_entries_are_pinned():
    for spec in registry.REGISTRY.values():
        assert len(spec.sha256) == 64
        assert spec.license and spec.source and spec.limitations
        assert "/raw/main/" not in spec.url  # immutable commit URL, not a branch
        assert spec.files and all(len(h) == 64 for h in spec.files.values())
