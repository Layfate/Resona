"""Command-line entry point: ``python -m resona_worker <command> ...``.

All commands emit newline-delimited JSON on stdout (see ``protocol.py``) and
exit with status 0 on success, 1 on a handled error and 2 on a crash.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

from . import PROTOCOL_VERSION, __version__, protocol
from .protocol import WorkerError


def _default_models_dir() -> str:
    env = os.environ.get("RESONA_MODELS_DIR")
    if env:
        return env
    if sys.platform == "win32":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
    return str(base / "io.github.resona" / "models")


def cmd_info(args: argparse.Namespace) -> dict:
    from . import audio_io, devices
    from .models import registry

    ff = audio_io.find_ffmpeg(args.ffmpeg)
    return {
        "version": __version__,
        "protocol": PROTOCOL_VERSION,
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "devices": devices.describe(),
        "ffmpeg": {"path": ff, "version": audio_io.ffmpeg_version(ff)},
        "formats": audio_io.EXPORT_FORMATS,
        "models": registry.list_models(args.models_dir),
        "modelsDir": args.models_dir,
    }


def cmd_analyze(args: argparse.Namespace) -> dict:
    from . import analysis, audio_io

    audio, sr, info = audio_io.load_audio(args.input, args.ffmpeg)
    data = analysis.analyze(audio, sr)
    data["info"] = info.to_dict()
    return data


def cmd_preview(args: argparse.Namespace) -> dict:
    """Decode any supported input to a 16-bit WAV the web view can play."""
    from . import audio_io

    audio, sr, info = audio_io.load_audio(args.input, args.ffmpeg)
    written = audio_io.save_audio(args.output, audio, sr, "wav", bit_depth=16)
    return {"output": written["path"], "info": info.to_dict()}


def cmd_process(args: argparse.Namespace) -> dict:
    from . import pipeline

    raw = sys.stdin.read() if args.job == "-" else Path(args.job).read_text(encoding="utf-8")
    try:
        spec = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WorkerError("bad_job", f"Invalid job JSON: {exc}") from exc
    spec.setdefault("modelsDir", args.models_dir)
    if args.ffmpeg and not spec.get("ffmpeg"):
        spec["ffmpeg"] = args.ffmpeg
    job = pipeline.Job.from_dict(spec)
    return pipeline.run(job)


def cmd_models(args: argparse.Namespace) -> dict:
    from .models import registry

    root = args.models_dir
    if args.action == "list":
        return {"models": registry.list_models(root, deep=args.deep)}
    if not args.id:
        raise WorkerError("bad_args", "A model id is required.")
    if args.action == "install":
        prog = protocol.Progress({"download": 1})
        prog.start("download", "Downloading model")
        st = registry.install(root, args.id, on_progress=lambda f: prog.update(f, "Downloading model"))
        prog.finish()
        return {"model": st}
    if args.action == "import":
        return {"model": registry.install_from_archive(root, args.id, args.archive)}
    if args.action == "verify":
        st = registry.status(root, registry.get(args.id), deep=True)
        if st["installed"] and not st["verified"]:
            raise WorkerError("model_corrupt", f"{st['name']} failed integrity verification; re-download it.")
        return {"model": st}
    if args.action == "remove":
        registry.remove(root, args.id)
        return {"model": registry.status(root, registry.get(args.id))}
    raise WorkerError("bad_args", f"Unknown models action {args.action}")


def cmd_bench(args: argparse.Namespace) -> dict:
    from . import benchmark

    return benchmark.run(models_dir=args.models_dir, device=args.device, seconds=args.seconds)


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="resona-worker", description="Resona audio enhancement worker")
    p.add_argument("--models-dir", default=_default_models_dir())
    p.add_argument("--ffmpeg", default=None, help="Path to an FFmpeg binary")
    p.add_argument("--version", action="version", version=__version__)
    sub = p.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="Environment, devices, FFmpeg and model status")

    a = sub.add_parser("analyze", help="Diagnose a file (clipping, bandwidth, loudness, noise)")
    a.add_argument("input")

    pv = sub.add_parser("preview", help="Decode a file to a playable 16-bit WAV")
    pv.add_argument("input")
    pv.add_argument("output")

    pr = sub.add_parser("process", help="Run an enhancement job")
    pr.add_argument("--job", required=True, help="Path to a job JSON file, or '-' for stdin")

    m = sub.add_parser("models", help="Manage pretrained models")
    m.add_argument("action", choices=["list", "install", "import", "verify", "remove"])
    m.add_argument("id", nargs="?")
    m.add_argument("--archive", help="Local archive for 'import'")
    m.add_argument("--deep", action="store_true", help="Re-hash files when listing")

    b = sub.add_parser("bench", help="Measure processing speed of every stage")
    b.add_argument("--device", default="auto")
    b.add_argument("--seconds", type=float, default=60.0)
    return p


COMMANDS = {
    "info": cmd_info,
    "analyze": cmd_analyze,
    "preview": cmd_preview,
    "process": cmd_process,
    "models": cmd_models,
    "bench": cmd_bench,
}


def main(argv: list[str] | None = None) -> int:
    protocol.install_stdout_guard()
    args = build_parser().parse_args(argv)
    try:
        data = COMMANDS[args.command](args)
        protocol.result(data)
        return 0
    except WorkerError as exc:
        protocol.error(exc.code, exc.message)
        return 1
    except MemoryError:
        protocol.error("out_of_memory", "Not enough memory. Try a smaller chunk size in Settings.")
        return 1
    except KeyboardInterrupt:
        protocol.error("cancelled", "Cancelled")
        return 1
    except Exception as exc:  # pragma: no cover - unexpected failures
        traceback.print_exc(file=sys.stderr)
        protocol.error("internal", f"{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
