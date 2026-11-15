"""The enhancement pipeline.

Order of operations::

    decode → declip (native rate) → resample → global analysis
           → [chunked: denoise → vocal clarity → bandwidth extension]
           → loudness match / normalise → true-peak limiter → encode

Global analysis (noise profile, bandwidth cutoff, loudness) is computed once
for the whole file so every chunk is processed with identical parameters;
chunks overlap and are crossfaded so boundaries are inaudible.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from . import analysis, audio_io
from .dsp import bandwidth, chunking, declip, dehiss, limiter, loudness
from .dsp.resample import expected_length, fix_length, resample
from .presets import dfn_atten_limit, stages_for
from .protocol import Progress, WorkerError, log

MP3_RATES = (8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000)


@dataclass
class Job:
    input: str
    output: str
    format: str = "flac"
    bit_depth: int = 24
    bitrate_kbps: int = 320
    sample_rate: int = 0  # 0 = automatic
    device: str = "auto"
    threads: int = 0
    models_dir: str = ""
    ffmpeg: str | None = None
    preset: str = "music"
    stages: dict = field(default_factory=dict)
    loudness_mode: str = "match"  # match | normalize | off
    target_lufs: float = -14.0
    true_peak_db: float = -1.0
    chunk_seconds: float = 20.0
    stereo_link: bool = True

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> Job:
        if not d.get("input") or not d.get("output"):
            raise WorkerError("bad_job", "Job requires 'input' and 'output'.")
        loud = d.get("loudness") or {}
        job = cls(
            input=str(d["input"]),
            output=str(d["output"]),
            format=str(d.get("format", "flac")).lower(),
            bit_depth=int(d.get("bitDepth", 24)),
            bitrate_kbps=int(d.get("bitrateKbps", 320)),
            sample_rate=int(d.get("sampleRate") or 0),
            device=str(d.get("device", "auto")),
            threads=int(d.get("threads", 0)),
            models_dir=str(d.get("modelsDir", "")),
            ffmpeg=d.get("ffmpeg") or None,
            preset=str(d.get("preset", "music")),
            loudness_mode=str(loud.get("mode", "match")),
            target_lufs=float(loud.get("targetLufs", -14.0)),
            true_peak_db=float(loud.get("truePeakDb", -1.0)),
            chunk_seconds=float(d.get("chunkSeconds", 20.0)),
            stereo_link=bool(d.get("stereoLink", True)),
        )
        overrides = d.get("stages") if isinstance(d.get("stages"), dict) else None
        job.stages = stages_for(job.preset if job.preset != "custom" else "", overrides)
        if job.format not in audio_io.EXPORT_FORMATS:
            raise WorkerError("bad_format", f"Unsupported export format: {job.format}")
        if job.bit_depth not in (16, 24, 32):
            raise WorkerError("bad_job", "bitDepth must be 16, 24 or 32.")
        job.true_peak_db = min(max(job.true_peak_db, -12.0), 0.0)
        job.chunk_seconds = min(max(job.chunk_seconds, 5.0), 600.0)
        if Path(job.input).resolve() == Path(job.output).resolve():
            raise WorkerError("bad_job", "Output would overwrite the input file.")
        return job


def _choose_rate(job: Job, sr_in: int) -> int:
    if job.sample_rate > 0:
        sr = job.sample_rate
    elif job.stages["bandwidth"]["enabled"] and sr_in < 44100:
        sr = 48000
    else:
        sr = sr_in
    if job.format == "opus":
        sr = 48000
    if job.format == "mp3" and sr not in MP3_RATES:
        sr = 48000 if sr > 44100 else 44100
    return sr


class _Timer:
    def __init__(self) -> None:
        self.times: dict[str, float] = {}

    def add(self, key: str, dt: float) -> None:
        self.times[key] = self.times.get(key, 0.0) + dt


def run(job: Job) -> dict:
    t_start = time.perf_counter()
    st = job.stages
    need_dfn = (st["denoise"]["enabled"] and st["denoise"]["engine"] == "dfn") or st["vocal"]["enabled"]
    weights = {"load": 4, "analyze": 4}
    if st["declip"]["enabled"]:
        weights["declip"] = 8
    if need_dfn:
        weights["model"] = 2
    weights["process"] = 60
    weights["master"] = 6
    weights["encode"] = 6
    prog = Progress(weights)
    timer = _Timer()
    warnings: list[str] = []

    # ---------------------------------------------------------------- decode
    prog.start("load", "Decoding audio")
    t0 = time.perf_counter()
    audio, sr_in, info = audio_io.load_audio(job.input, job.ffmpeg)
    timer.add("decode", time.perf_counter() - t0)
    n_in = audio.shape[1]
    if n_in == 0:
        raise WorkerError("decode_failed", "The file contains no audio.")
    if not np.all(np.isfinite(audio)):
        audio = np.nan_to_num(audio)
        warnings.append("Input contained invalid samples (NaN/Inf) which were zeroed.")
    log(f"Loaded {info.duration:.1f}s, {sr_in} Hz, {audio.shape[0]} ch via {info.decoder}")

    prog.start("analyze", "Analysing input")
    t0 = time.perf_counter()
    in_lufs = loudness.integrated_loudness(audio, sr_in)
    in_tp = loudness.true_peak(audio)
    clip_stats = declip.detect(audio)
    in_spectrum = analysis.spectrum_summary(audio, sr_in)
    timer.add("analysis", time.perf_counter() - t0)
    details: dict[str, Any] = {}

    # ---------------------------------------------------------------- declip
    if st["declip"]["enabled"]:
        prog.start("declip", "Repairing clipped peaks")
        t0 = time.perf_counter()
        if clip_stats.is_clipped:
            audio, repaired = declip.declip(audio, on_progress=lambda f: prog.update(f, "Repairing clipped peaks"))
            details["declip"] = {"repairedSamples": repaired, **clip_stats.to_dict()}
        else:
            details["declip"] = {"repairedSamples": 0, **clip_stats.to_dict(), "skipped": "no clipping detected"}
        timer.add("declip", time.perf_counter() - t0)

    # -------------------------------------------------------------- resample
    sr = _choose_rate(job, sr_in)
    if sr != sr_in:
        t0 = time.perf_counter()
        audio = resample(audio, sr_in, sr)
        timer.add("resample", time.perf_counter() - t0)
    n_out = expected_length(n_in, sr_in, sr)

    # ------------------------------------------------------- global analysis
    cutoff = None
    if st["bandwidth"]["enabled"]:
        t0 = time.perf_counter()
        cutoff = bandwidth.detect_cutoff(audio, sr)
        details["bandwidth"] = dict(cutoff)
        if not cutoff["bandLimited"]:
            details["bandwidth"]["skipped"] = "full bandwidth already present"
        timer.add("analysis", time.perf_counter() - t0)
    profile = None
    if st["denoise"]["enabled"] and st["denoise"]["engine"] == "spectral":
        t0 = time.perf_counter()
        profile = dehiss.estimate_noise_profile(audio, sr)
        timer.add("analysis", time.perf_counter() - t0)

    model = None
    if need_dfn:
        prog.start("model", "Loading DeepFilterNet3")
        t0 = time.perf_counter()
        from .models import registry
        from .models.deepfilternet import DeepFilterNet

        mdir = registry.require(job.models_dir, "deepfilternet3")
        model = DeepFilterNet(mdir, device=job.device, threads=job.threads)
        timer.add("model_load", time.perf_counter() - t0)
        details["device"] = model.device
        log(f"DeepFilterNet3 running on {model.device}")

    # ---------------------------------------------------------- chunk stages
    def run_dfn(seg: np.ndarray, atten: float | None) -> np.ndarray:
        x48 = resample(seg, sr, 48000) if sr != 48000 else seg
        y48 = model.enhance(x48, atten_lim_db=atten, link_channels=job.stereo_link)
        return fix_length(resample(y48, 48000, sr), seg.shape[1]) if sr != 48000 else y48

    def process(seg: np.ndarray) -> np.ndarray:
        y = seg
        if st["denoise"]["enabled"]:
            t = time.perf_counter()
            if st["denoise"]["engine"] == "dfn":
                y = run_dfn(y, dfn_atten_limit(float(st["denoise"]["strength"])))
            else:
                y = dehiss.apply(y, profile, strength=float(st["denoise"]["strength"]))
            timer.add("denoise", time.perf_counter() - t)
        if st["vocal"]["enabled"]:
            t = time.perf_counter()
            amount = float(st["vocal"].get("amountDb", 3.0))
            a = 10.0 ** (np.clip(amount, -12.0, 9.0) / 20.0) - 1.0
            mid = y.mean(axis=0, keepdims=True)
            voice = run_dfn(mid, None)  # speech/vocal estimate of the centre channel
            y = y + a * voice
            timer.add("vocal", time.perf_counter() - t)
        if cutoff and cutoff["bandLimited"]:
            t = time.perf_counter()
            y = bandwidth.extend(y, sr, cutoff["cutoffHz"], strength=float(st["bandwidth"]["strength"]))
            timer.add("bandwidth", time.perf_counter() - t)
        return y

    prog.start("process", "Enhancing")
    any_chunk_stage = st["denoise"]["enabled"] or st["vocal"]["enabled"] or (cutoff and cutoff["bandLimited"])
    if any_chunk_stage:
        audio = chunking.process_chunked(
            audio, process,
            chunk=int(job.chunk_seconds * sr), context=int(2.0 * sr), fade=int(0.5 * sr),
            on_progress=lambda f: prog.update(f, "Enhancing"),
        )
    if model is not None:
        model.close()
        model = None

    # ------------------------------------------------------------- mastering
    prog.start("master", "Matching loudness and limiting peaks")
    t0 = time.perf_counter()
    audio = fix_length(audio, n_out)
    pre_lufs = loudness.integrated_loudness(audio, sr)
    gain_db = 0.0
    if job.loudness_mode == "match" and math.isfinite(in_lufs) and math.isfinite(pre_lufs):
        gain_db = in_lufs - pre_lufs
    elif job.loudness_mode == "normalize" and math.isfinite(pre_lufs):
        gain_db = job.target_lufs - pre_lufs
    gain_db = float(np.clip(gain_db, -24.0, 24.0))
    if gain_db != 0.0:
        audio = audio * np.float32(loudness.db_to_gain(gain_db))
    audio, reduction = limiter.limit(audio, sr, ceiling_db=job.true_peak_db)
    if reduction > 3.0:
        warnings.append(f"The limiter reduced peaks by up to {reduction:.1f} dB to prevent clipping.")
    out_lufs = loudness.integrated_loudness(audio, sr)
    out_tp = loudness.true_peak(audio)
    out_spectrum = analysis.spectrum_summary(audio, sr)
    out_peaks = analysis.peaks(audio)
    timer.add("master", time.perf_counter() - t0)

    # ---------------------------------------------------------------- encode
    prog.start("encode", f"Writing {job.format.upper()}")
    t0 = time.perf_counter()
    written = audio_io.save_audio(
        job.output, audio, sr, job.format, bit_depth=job.bit_depth, bitrate_kbps=job.bitrate_kbps,
        ffmpeg=job.ffmpeg, metadata_source=job.input,
    )
    timer.add("encode", time.perf_counter() - t0)
    prog.finish()

    total = time.perf_counter() - t_start
    duration = n_in / sr_in
    return {
        "output": written["path"],
        "format": job.format,
        "encoder": written["encoder"],
        "bytes": written["bytes"],
        "sampleRateIn": sr_in,
        "sampleRateOut": sr,
        "channels": int(audio.shape[0]),
        "framesIn": n_in,
        "framesOut": int(audio.shape[1]),
        "durationIn": duration,
        "durationOut": audio.shape[1] / sr,
        "inputLufs": in_lufs,
        "outputLufs": out_lufs,
        "inputTruePeakDb": loudness.to_db(in_tp),
        "outputTruePeakDb": loudness.to_db(out_tp),
        "gainDb": gain_db,
        "limiterReductionDb": reduction,
        "inputSpectrum": in_spectrum,
        "outputSpectrum": out_spectrum,
        "outputPeaks": out_peaks,
        "stages": {k: v for k, v in st.items()},
        "details": details,
        "device": details.pop("device", "cpu"),
        "timings": {k: round(v, 3) for k, v in timer.times.items()},
        "elapsed": total,
        "realtimeFactor": duration / total if total > 0 else None,
        "warnings": warnings,
    }
