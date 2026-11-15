"""End-to-end tests through the CLI protocol, exactly as the desktop app uses it."""

import json
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf
from conftest import ROOT, models_dir, requires_dfn

from resona_worker.benchmark import synthetic_music
from resona_worker.dsp import loudness


def run_worker(*args, stdin: str | None = None, env_models: str | None = None):
    cmd = [sys.executable, "-m", "resona_worker"]
    if env_models:
        cmd += ["--models-dir", env_models]
    cmd += list(args)
    proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True, cwd=ROOT, timeout=600)
    msgs = [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]
    return proc.returncode, msgs, proc.stderr


def final(msgs):
    ends = [m for m in msgs if m["type"] in ("result", "error")]
    assert len(ends) == 1, msgs
    return ends[0]


@pytest.fixture()
def song(tmp_path) -> Path:
    """A band-limited, slightly clipped, noisy stereo 'song' at 44.1 kHz."""
    from scipy.signal import ellip, sosfiltfilt

    sr = 44100
    x = synthetic_music(12.0, sr)
    x = np.clip(x * 1.3, -0.45, 0.45)  # clipped master...
    x = sosfiltfilt(ellip(10, 0.1, 90, 14000, fs=sr, output="sos"), x, axis=-1)  # ...then a codec low-pass
    x = np.clip(x, -0.45, 0.45).astype(np.float32)  # encoder re-clips the overshoot
    p = tmp_path / "song.wav"
    sf.write(p, x.T, sr, subtype="PCM_16")
    return p


def test_info_reports_environment():
    code, msgs, _ = run_worker("info")
    assert code == 0
    data = final(msgs)["data"]
    assert data["version"] and data["protocol"] == 1
    assert "cpu" in data["devices"]["onnxDevices"]
    assert "flac" in data["formats"]


def test_analyze(song):
    code, msgs, err = run_worker("analyze", str(song))
    assert code == 0, err
    data = final(msgs)["data"]
    assert data["clipping"]["isClipped"]
    assert data["bandwidth"]["bandLimited"]
    assert 13000 < data["bandwidth"]["cutoffHz"] < 15000
    assert data["info"]["sampleRate"] == 44100
    assert len(data["spectrum"]["freqs"]) == len(data["spectrum"]["db"])


@pytest.mark.parametrize(
    "fmt,ext", [("flac", "flac"), ("wav", "wav"), ("aiff", "aiff"), ("mp3", "mp3"), ("ogg", "ogg"), ("opus", "opus")]
)
def test_process_dsp_preset(song, tmp_path, fmt, ext):
    out = tmp_path / f"out.{ext}"
    job = {"input": str(song), "output": str(out), "format": fmt, "preset": "music", "bitDepth": 16}
    code, msgs, err = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 0, err
    res = final(msgs)
    assert res["type"] == "result", res
    data = res["data"]
    progress = [m["progress"] for m in msgs if m["type"] == "progress"]
    assert progress == sorted(progress) and progress[-1] == 1.0
    assert out.is_file()
    assert not list(tmp_path.glob(".*resona-*"))  # no temp files left behind
    info = sf.info(out)
    src = sf.info(song)
    # Duration preserved (lossy codecs add encoder padding of a few ms at most).
    assert abs(info.duration - src.duration) < (0.0005 if fmt in ("flac", "wav", "aiff") else 0.08)
    assert info.channels == 2
    if fmt == "opus":
        assert info.samplerate == 48000  # Opus is always 48 kHz
    # Loudness matched to the input; no clipping (true peak below the -1 dBTP ceiling).
    assert abs(data["outputLufs"] - data["inputLufs"]) < 0.5
    assert data["outputTruePeakDb"] <= -0.95
    assert data["details"]["declip"]["repairedSamples"] > 0
    assert data["details"]["bandwidth"]["bandLimited"]


def test_lossless_output_alignment(tmp_path):
    """Processing must not shift audio in time (channel alignment / sync)."""
    sr = 48000
    x = np.zeros((2, sr * 6), np.float32)
    x[0, sr * 2] = 0.5  # click on the left channel at exactly 2.0 s
    x[1, sr * 3] = 0.5  # click on the right channel at exactly 3.0 s
    rng = np.random.default_rng(1)
    x += rng.standard_normal(x.shape).astype(np.float32) * 0.002
    src = tmp_path / "click.wav"
    sf.write(src, x.T, sr, subtype="FLOAT")
    out = tmp_path / "click_out.wav"
    job = {"input": str(src), "output": str(out), "format": "wav", "bitDepth": 32, "preset": "custom",
           "stages": {"denoise": {"enabled": True, "engine": "spectral", "strength": 0.5}},
           "loudness": {"mode": "off"}}
    code, msgs, err = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 0, err
    y, sr2 = sf.read(out, always_2d=True)
    assert sr2 == sr and y.shape[0] == x.shape[1]
    assert abs(int(np.argmax(np.abs(y[:, 0]))) - sr * 2) <= 1
    assert abs(int(np.argmax(np.abs(y[:, 1]))) - sr * 3) <= 1


def test_low_samplerate_is_upscaled(tmp_path):
    sr = 22050
    x = synthetic_music(5.0, sr)
    src = tmp_path / "low.wav"
    sf.write(src, x.T, sr)
    out = tmp_path / "low_out.flac"
    job = {"input": str(src), "output": str(out), "format": "flac", "preset": "custom",
           "stages": {"bandwidth": {"enabled": True, "strength": 0.6}}}
    code, msgs, err = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 0, err
    y, sr2 = sf.read(out, always_2d=True)
    assert sr2 == 48000
    assert y.shape[0] == int(round(x.shape[1] * 48000 / sr))
    spec = np.abs(np.fft.rfft(y[:, 0]))
    f = np.fft.rfftfreq(y.shape[0], 1 / sr2)
    assert spec[(f > 12000) & (f < 20000)].mean() > 1e-3 * spec[(f > 2000) & (f < 10000)].mean()


def test_errors_are_reported(tmp_path):
    job = {"input": str(tmp_path / "missing.wav"), "output": str(tmp_path / "o.flac")}
    code, msgs, _ = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 1
    assert final(msgs)["code"] == "not_found"
    code, msgs, _ = run_worker("process", "--job", "-", stdin="{not json")
    assert final(msgs)["code"] == "bad_job"


def test_refuses_to_overwrite_input(song):
    job = {"input": str(song), "output": str(song), "format": "wav"}
    code, msgs, _ = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 1 and final(msgs)["code"] == "bad_job"


def test_kill_leaves_no_partial_output(tmp_path):
    sr = 44100
    x = synthetic_music(90.0, sr)
    src = tmp_path / "long.wav"
    sf.write(src, x.T, sr)
    out = tmp_path / "long_out.flac"
    job = {"input": str(src), "output": str(out), "format": "flac", "preset": "restoration"}
    proc = subprocess.Popen([sys.executable, "-m", "resona_worker", "process", "--job", "-"], cwd=ROOT,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    proc.stdin.write(json.dumps(job))
    proc.stdin.close()
    # Wait for processing to start, then kill (this is how the app cancels).
    for line in proc.stdout:
        if '"stage":"process"' in line:
            break
    time.sleep(0.3)
    proc.kill()
    proc.wait(timeout=30)
    assert not out.exists()


@requires_dfn
def test_process_with_deepfilternet(song, tmp_path):
    out = tmp_path / "v.flac"
    job = {"input": str(song), "output": str(out), "format": "flac", "preset": "vocals", "device": "cpu",
           "stages": {"vocal": {"enabled": True, "amountDb": 3}}}
    code, msgs, err = run_worker("process", "--job", "-", stdin=json.dumps(job), env_models=models_dir())
    assert code == 0, err
    data = final(msgs)["data"]
    assert data["device"] == "cpu"
    y, sr = sf.read(out, always_2d=True)
    assert y.shape[0] == sf.info(song).frames
    assert loudness.true_peak(y.T) <= 10 ** (-0.95 / 20)


requires_ffmpeg = pytest.mark.skipif(
    __import__("resona_worker.audio_io", fromlist=["find_ffmpeg"]).find_ffmpeg() is None,
    reason="FFmpeg not found (set RESONA_FFMPEG or add it to PATH)",
)


@requires_ffmpeg
@pytest.mark.parametrize("fmt,ext", [("m4a", "m4a"), ("alac", "m4a"), ("mp3", "mp3"), ("opus", "opus")])
def test_ffmpeg_export(song, tmp_path, fmt, ext):
    out = tmp_path / f"ff_{fmt}.{ext}"
    job = {"input": str(song), "output": str(out), "format": fmt, "preset": "custom",
           "stages": {"denoise": {"enabled": True, "engine": "spectral", "strength": 0.4}}, "bitrateKbps": 192}
    code, msgs, err = run_worker("process", "--job", "-", stdin=json.dumps(job))
    assert code == 0, err
    data = final(msgs)["data"]
    assert data["encoder"] == "ffmpeg"
    # Decode the result back (M4A requires the FFmpeg decoder path).
    code, msgs, err = run_worker("analyze", str(out))
    assert code == 0, err
    info = final(msgs)["data"]["info"]
    assert info["channels"] == 2
    assert abs(info["duration"] - sf.info(song).duration) < 0.1
