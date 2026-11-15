"""Audio decoding / encoding.

Decoding prefers libsndfile (via ``soundfile``), which natively handles WAV,
FLAC, AIFF, OGG/Vorbis/Opus and MP3. Anything else (AAC/M4A, ALAC, WMA, …) is
decoded through FFmpeg when it is available.

Encoding writes to a temporary file next to the destination and atomically
renames it on success, so a cancelled or failed job never leaves a truncated
output behind.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .protocol import WorkerError, log

try:  # soundfile is a hard requirement, but give a clear error when missing.
    import soundfile as sf
except Exception as exc:  # pragma: no cover - environment problem
    raise WorkerError("missing_dependency", f"python-soundfile is not available: {exc}") from exc


# Formats Resona can export. ``codec`` documents what is used to encode.
EXPORT_FORMATS: dict[str, dict] = {
    "wav": {"label": "WAV", "lossless": True, "ext": "wav", "needs_ffmpeg": False},
    "flac": {"label": "FLAC", "lossless": True, "ext": "flac", "needs_ffmpeg": False},
    "aiff": {"label": "AIFF", "lossless": True, "ext": "aiff", "needs_ffmpeg": False},
    "mp3": {"label": "MP3", "lossless": False, "ext": "mp3", "needs_ffmpeg": False},
    "ogg": {"label": "Ogg Vorbis", "lossless": False, "ext": "ogg", "needs_ffmpeg": False},
    "opus": {"label": "Opus", "lossless": False, "ext": "opus", "needs_ffmpeg": False},
    "m4a": {"label": "AAC (M4A)", "lossless": False, "ext": "m4a", "needs_ffmpeg": True},
    "alac": {"label": "ALAC (M4A)", "lossless": True, "ext": "m4a", "needs_ffmpeg": True},
}

_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW


@dataclass
class AudioInfo:
    path: str
    sample_rate: int
    channels: int
    frames: int
    duration: float
    format: str
    subtype: str | None
    decoder: str

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "sampleRate": self.sample_rate,
            "channels": self.channels,
            "frames": self.frames,
            "duration": self.duration,
            "format": self.format,
            "subtype": self.subtype,
            "decoder": self.decoder,
        }


# --------------------------------------------------------------------------- FFmpeg


def find_ffmpeg(explicit: str | None = None) -> str | None:
    """Locate an FFmpeg binary: explicit path, $RESONA_FFMPEG, then $PATH."""
    for candidate in (explicit, os.environ.get("RESONA_FFMPEG")):
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return shutil.which("ffmpeg")


def _ffprobe_for(ffmpeg: str) -> str | None:
    p = Path(ffmpeg)
    name = "ffprobe.exe" if p.suffix.lower() == ".exe" else "ffprobe"
    sibling = p.with_name(name)
    if sibling.is_file():
        return str(sibling)
    return shutil.which("ffprobe")


def ffmpeg_version(ffmpeg: str | None) -> str | None:
    if not ffmpeg:
        return None
    try:
        out = subprocess.run(
            [ffmpeg, "-hide_banner", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=_NO_WINDOW,
        )
        first = out.stdout.splitlines()[0] if out.stdout else ""
        return first.strip() or None
    except Exception:
        return None


def _probe_ffmpeg(path: str, ffmpeg: str) -> tuple[int, int, float | None]:
    ffprobe = _ffprobe_for(ffmpeg)
    if ffprobe:
        proc = subprocess.run(
            [ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=sample_rate,channels:format=duration", "-of", "json", path],
            capture_output=True, text=True, timeout=60, creationflags=_NO_WINDOW,
        )
        if proc.returncode == 0:
            data = json.loads(proc.stdout or "{}")
            streams = data.get("streams") or []
            if streams:
                sr = int(streams[0].get("sample_rate") or 0)
                ch = int(streams[0].get("channels") or 0)
                dur = data.get("format", {}).get("duration")
                if sr > 0 and ch > 0:
                    return sr, ch, float(dur) if dur else None
    # Fallback: parse ffmpeg's stream banner.
    proc = subprocess.run([ffmpeg, "-hide_banner", "-i", path], capture_output=True, text=True,
                          timeout=60, creationflags=_NO_WINDOW)
    import re

    m = re.search(r"Audio:.*?(\d+) Hz, ([^,]+),", proc.stderr)
    if not m:
        raise WorkerError("decode_failed", "FFmpeg could not find an audio stream in this file.")
    sr = int(m.group(1))
    layout = m.group(2).strip()
    ch = {"mono": 1, "stereo": 2}.get(layout)
    if ch is None:
        m2 = re.match(r"(\d+)(?:\.(\d+))?", layout)
        ch = (int(m2.group(1)) + int(m2.group(2) or 0)) if m2 else 2
    return sr, ch, None


def _decode_ffmpeg(path: str, ffmpeg: str) -> tuple[np.ndarray, int]:
    sr, ch, _ = _probe_ffmpeg(path, ffmpeg)
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-i", path, "-map", "0:a:0", "-f", "f32le",
           "-acodec", "pcm_f32le", "-ac", str(ch), "-ar", str(sr), "-"]
    proc = subprocess.run(cmd, capture_output=True, creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        msg = proc.stderr.decode(errors="replace").strip().splitlines()[-1:] or ["unknown error"]
        raise WorkerError("decode_failed", f"FFmpeg failed to decode the file: {msg[0]}")
    data = np.frombuffer(proc.stdout, dtype="<f4")
    frames = len(data) // ch
    audio = data[: frames * ch].reshape(frames, ch).T.copy()
    return audio, sr


# --------------------------------------------------------------------------- decode


def probe(path: str, ffmpeg: str | None = None) -> AudioInfo:
    if not Path(path).is_file():
        raise WorkerError("not_found", f"File not found: {path}")
    try:
        info = sf.info(path)
        return AudioInfo(path, int(info.samplerate), int(info.channels), int(info.frames),
                         float(info.frames) / info.samplerate, info.format, info.subtype, "libsndfile")
    except Exception:
        pass
    ff = find_ffmpeg(ffmpeg)
    if not ff:
        raise WorkerError(
            "unsupported_format",
            "This format needs FFmpeg to decode. Install FFmpeg or set its path in Settings.",
        )
    sr, ch, dur = _probe_ffmpeg(path, ff)
    frames = int(round((dur or 0.0) * sr))
    return AudioInfo(path, sr, ch, frames, dur or 0.0, Path(path).suffix.lstrip(".").upper(), None, "ffmpeg")


def load_audio(path: str, ffmpeg: str | None = None) -> tuple[np.ndarray, int, AudioInfo]:
    """Decode a file to float32 ``[channels, frames]``."""
    info = probe(path, ffmpeg)
    if info.decoder == "libsndfile":
        try:
            data, sr = sf.read(path, dtype="float32", always_2d=True)
            audio = np.ascontiguousarray(data.T)
            info.frames = audio.shape[1]
            info.duration = audio.shape[1] / sr
            return audio, int(sr), info
        except Exception as exc:
            ff = find_ffmpeg(ffmpeg)
            if not ff:
                raise WorkerError("decode_failed", f"Could not decode audio: {exc}") from exc
            log(f"libsndfile failed ({exc}); retrying with FFmpeg", "warn")
    ff = find_ffmpeg(ffmpeg)
    if not ff:
        raise WorkerError("unsupported_format", "This format needs FFmpeg to decode.")
    audio, sr = _decode_ffmpeg(path, ff)
    info.decoder = "ffmpeg"
    info.frames = audio.shape[1]
    info.duration = audio.shape[1] / sr
    info.sample_rate = sr
    info.channels = audio.shape[0]
    if audio.shape[1] == 0:
        raise WorkerError("decode_failed", "The file contains no audio samples.")
    return audio, sr, info


# --------------------------------------------------------------------------- encode


def tpdf_dither_to_int16(audio: np.ndarray, seed: int = 0x5E50) -> np.ndarray:
    """Quantise float audio to int16 with TPDF dither (±1 LSB triangular)."""
    rng = np.random.default_rng(seed)
    scale = 32767.0
    noise = (rng.random(audio.shape, dtype=np.float32) - rng.random(audio.shape, dtype=np.float32))
    q = np.round(audio * scale + noise)
    return np.clip(q, -32768, 32767).astype(np.int16)


def _temp_path(dest: Path) -> Path:
    return dest.with_name(f".{dest.stem}.resona-{uuid.uuid4().hex[:8]}.tmp{dest.suffix}")


def save_audio(
    dest: str,
    audio: np.ndarray,
    sr: int,
    fmt: str,
    *,
    bit_depth: int = 24,
    bitrate_kbps: int = 320,
    ffmpeg: str | None = None,
    metadata_source: str | None = None,
) -> dict:
    """Encode ``audio`` (float32 ``[C, N]``) and atomically write it to ``dest``."""
    fmt = fmt.lower()
    if fmt not in EXPORT_FORMATS:
        raise WorkerError("bad_format", f"Unsupported export format: {fmt}")
    dest_p = Path(dest)
    dest_p.parent.mkdir(parents=True, exist_ok=True)
    tmp = _temp_path(dest_p)
    audio = np.clip(np.nan_to_num(audio, nan=0.0, posinf=0.0, neginf=0.0), -1.0, 1.0).astype(np.float32)
    ff = find_ffmpeg(ffmpeg)
    encoder = "libsndfile"
    try:
        if fmt in ("m4a", "alac") or (fmt in ("mp3", "opus") and ff):
            if not ff:
                raise WorkerError("ffmpeg_required", f"Exporting {EXPORT_FORMATS[fmt]['label']} requires FFmpeg.")
            _encode_ffmpeg(tmp, audio, sr, fmt, bit_depth, bitrate_kbps, ff, metadata_source)
            encoder = "ffmpeg"
        else:
            _encode_soundfile(tmp, audio, sr, fmt, bit_depth, bitrate_kbps)
        os.replace(tmp, dest_p)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise
    return {"path": str(dest_p), "format": fmt, "encoder": encoder, "bytes": dest_p.stat().st_size}


def _write_blocks(tmp: Path, data: np.ndarray, sr: int, block: int = 1 << 14, **kwargs) -> None:
    """Write in blocks: libsndfile's Vorbis/LAME paths can overflow the stack on huge writes."""
    with sf.SoundFile(str(tmp), "w", samplerate=sr, channels=data.shape[1], **kwargs) as fh:
        for a in range(0, data.shape[0], block):
            fh.write(data[a:a + block])


def _encode_soundfile(tmp: Path, audio: np.ndarray, sr: int, fmt: str, bit_depth: int, kbps: int) -> None:
    data = audio.T
    if fmt in ("wav", "aiff", "flac"):
        container = {"wav": "WAV", "aiff": "AIFF", "flac": "FLAC"}[fmt]
        if bit_depth == 16:
            sf.write(str(tmp), tpdf_dither_to_int16(data), sr, format=container, subtype="PCM_16")
        elif bit_depth == 32 and fmt != "flac":
            sf.write(str(tmp), data, sr, format=container, subtype="FLOAT")
        else:
            sf.write(str(tmp), data, sr, format=container, subtype="PCM_24")
        return
    if fmt == "mp3":
        # libsndfile maps compression_level 0..1 onto LAME quality; 0 is best.
        level = float(np.clip((320 - kbps) / 256.0, 0.0, 1.0))
        if sr not in (32000, 44100, 48000, 16000, 22050, 24000, 8000, 11025, 12000):
            raise WorkerError("bad_samplerate", f"MP3 does not support {sr} Hz.")
        _write_blocks(tmp, data, sr, format="MP3", subtype="MPEG_LAYER_III",
                      compression_level=level, bitrate_mode="CONSTANT")
        return
    if fmt == "ogg":
        level = float(np.clip((320 - kbps) / 256.0, 0.0, 1.0))
        _write_blocks(tmp, data, sr, format="OGG", subtype="VORBIS", compression_level=level)
        return
    if fmt == "opus":
        if sr != 48000:
            raise WorkerError("bad_samplerate", "Opus export requires 48 kHz output (or FFmpeg).")
        _write_blocks(tmp, data, sr, format="OGG", subtype="OPUS")
        return
    raise WorkerError("bad_format", f"Unsupported export format: {fmt}")


def _encode_ffmpeg(tmp: Path, audio: np.ndarray, sr: int, fmt: str, bit_depth: int, kbps: int,
                   ffmpeg: str, metadata_source: str | None) -> None:
    ch = audio.shape[0]
    cmd = [ffmpeg, "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(sr), "-ac", str(ch), "-i", "-"]
    if metadata_source and Path(metadata_source).is_file():
        cmd += ["-i", metadata_source, "-map", "0:a", "-map_metadata", "1"]
    if fmt == "mp3":
        cmd += ["-c:a", "libmp3lame", "-b:a", f"{kbps}k"]
    elif fmt == "opus":
        cmd += ["-c:a", "libopus", "-b:a", f"{min(kbps, 256)}k"]
    elif fmt == "m4a":
        cmd += ["-c:a", "aac", "-b:a", f"{kbps}k", "-movflags", "+faststart"]
    elif fmt == "alac":
        cmd += ["-c:a", "alac", "-sample_fmt", "s16p" if bit_depth == 16 else "s32p"]
    cmd += ["-f", {"mp3": "mp3", "opus": "ogg", "m4a": "ipod", "alac": "ipod"}[fmt], str(tmp)]
    payload = np.ascontiguousarray(audio.T).astype("<f4").tobytes()
    proc = subprocess.run(cmd, input=payload, capture_output=True, creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        err = proc.stderr.decode(errors="replace").strip().splitlines()
        raise WorkerError("encode_failed", f"FFmpeg failed to encode: {err[-1] if err else 'unknown error'}")
