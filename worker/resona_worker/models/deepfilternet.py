"""DeepFilterNet3 inference with ONNX Runtime and NumPy (no PyTorch needed).

This is a faithful port of the offline ``df.enhance.enhance`` path of the
reference implementation (Rikorose/DeepFilterNet, MIT/Apache-2.0):

1. Real-time-style STFT (Vorbis window, n_fft=960, hop=480 @ 48 kHz) as in libDF.
2. Features: ERB-band log power with exponential mean normalisation and the
   unit-normalised complex spectrum of the lowest 96 bins.
3. Encoder → ERB decoder (32 band gains) and DF decoder (order-5 complex filters).
4. Stage 1: ERB gains applied to all bins. Stage 2: deep filtering of the low
   bins over 5 frames (2 frames look-ahead).
5. Optional attenuation limit (mix with the noisy spectrum), ISTFT and delay
   compensation.

``tests/test_deepfilternet.py`` checks the output sample-by-sample against the
official PyTorch implementation when it is available.
"""

from __future__ import annotations

import configparser
import math
from collections.abc import Callable
from pathlib import Path

import numpy as np
from scipy.signal import lfilter

from ..devices import resolve_onnx
from ..dsp.chunking import process_chunked
from ..dsp.resample import resample

SR = 48000


def _freq2erb(f: float) -> float:
    return 9.265 * math.log1p(f / (24.7 * 9.265))


def _erb2freq(e: float) -> float:
    return 24.7 * 9.265 * (math.exp(e / 9.265) - 1.0)


def erb_widths(sr: int, fft_size: int, nb_bands: int, min_nb_freqs: int) -> np.ndarray:
    """Port of ``libDF::erb_fb``; returns the number of FFT bins per ERB band."""
    nyq = sr // 2
    freq_width = sr / fft_size
    erb_low = _freq2erb(0.0)
    erb_high = _freq2erb(float(nyq))
    step = (erb_high - erb_low) / nb_bands
    widths = np.zeros(nb_bands, dtype=np.int64)
    prev = 0
    over = 0
    for i in range(1, nb_bands + 1):
        f = _erb2freq(erb_low + i * step)
        fb = int(round(f / freq_width))
        nb = fb - prev - over
        if nb < min_nb_freqs:
            over = min_nb_freqs - nb
            nb = min_nb_freqs
        else:
            over = 0
        widths[i - 1] = nb
        prev = fb
    widths[-1] += 1
    too_large = int(widths.sum()) - (fft_size // 2 + 1)
    if too_large > 0:
        widths[-1] -= too_large
    assert int(widths.sum()) == fft_size // 2 + 1
    return widths


class DeepFilterNet:
    def __init__(self, model_dir: str | Path, device: str = "auto", threads: int = 0):
        import onnxruntime as ort

        model_dir = Path(model_dir)
        cfg = configparser.ConfigParser()
        cfg.read(model_dir / "config.ini", encoding="utf-8")
        df = cfg["df"]
        net = cfg["deepfilternet"]
        self.sr = int(df.get("sr", "48000"))
        self.n_fft = int(df.get("fft_size", "960"))
        self.hop = int(df.get("hop_size", "480"))
        self.nb_erb = int(df.get("nb_erb", "32"))
        self.nb_df = int(df.get("nb_df", "96"))
        self.df_order = int(df.get("df_order", "5"))
        self.df_lookahead = int(df.get("df_lookahead", "2"))
        self.conv_lookahead = int(net.get("conv_lookahead", "2"))
        tau = float(df.get("norm_tau", "1"))
        self.alpha = self._norm_alpha(self.sr, self.hop, tau)
        min_nb = int(df.get("min_nb_erb_freqs", "2"))
        self.widths = erb_widths(self.sr, self.n_fft, self.nb_erb, min_nb)
        self.band_starts = np.concatenate(([0], np.cumsum(self.widths)[:-1]))
        self.band_of_bin = np.repeat(np.arange(self.nb_erb), self.widths)

        n = np.arange(self.n_fft)
        s = np.sin(0.5 * np.pi * (n + 0.5) / (self.n_fft // 2))
        self.window = np.sin(0.5 * np.pi * s * s).astype(np.float32)
        self.wnorm = 1.0 / (self.n_fft ** 2 / (2 * self.hop))

        providers, self.device = resolve_onnx(device)
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads > 0:
            opts.intra_op_num_threads = threads
        if self.device == "directml":
            opts.enable_mem_pattern = False
            opts.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        self._sessions = {
            name: ort.InferenceSession(str(model_dir / f"{name}.onnx"), sess_options=opts, providers=providers)
            for name in ("enc", "erb_dec", "df_dec")
        }
        active = self._sessions["enc"].get_providers()
        if self.device != "cpu" and active and active[0] == "CPUExecutionProvider":
            self.device = "cpu"

    @staticmethod
    def _norm_alpha(sr: int, hop: int, tau: float) -> float:
        a_ = math.exp(-(hop / sr) / tau)
        precision = 3
        a = 1.0
        while a >= 1.0:
            a = round(a_, precision)
            precision += 1
        return a

    def close(self) -> None:
        self._sessions.clear()

    # ------------------------------------------------------------------ STFT

    def analysis(self, x: np.ndarray) -> np.ndarray:
        """``[N]`` (N multiple of hop) -> ``[T, F]`` complex64, matching libDF."""
        t = x.shape[-1] // self.hop
        xp = np.concatenate([np.zeros(self.n_fft - self.hop, dtype=np.float32), x[: t * self.hop]])
        frames = np.lib.stride_tricks.sliding_window_view(xp, self.n_fft)[:: self.hop][:t]
        return (np.fft.rfft(frames * self.window, axis=-1) * self.wnorm).astype(np.complex64)

    def synthesis(self, spec: np.ndarray) -> np.ndarray:
        """``[T, F]`` -> ``[T * hop]`` with libDF's overlap-add (delay n_fft - hop)."""
        frames = np.fft.irfft(spec, n=self.n_fft, axis=-1) * self.n_fft  # realfft is unnormalised
        frames = (frames * self.window).astype(np.float32)
        first = frames[:, : self.hop]
        second = frames[:, self.hop:]
        out = first.copy()
        out[1:] += second[:-1]
        return out.reshape(-1)

    # -------------------------------------------------------------- features

    def features(self, spec: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        a = self.alpha
        power = spec.real.astype(np.float32) ** 2 + spec.imag.astype(np.float32) ** 2
        erb = np.add.reduceat(power, self.band_starts, axis=1) / self.widths[None, :]
        erb_db = (10.0 * np.log10(erb + 1e-10)).astype(np.float32)
        init = np.linspace(-60.0, -90.0, self.nb_erb, dtype=np.float32)
        state = lfilter([1.0 - a], [1.0, -a], erb_db, axis=0, zi=(a * init)[None, :])[0]
        feat_erb = ((erb_db - state) / 40.0).astype(np.float32)

        cpx = spec[:, : self.nb_df]
        mag = np.abs(cpx).astype(np.float32)
        init_u = np.linspace(0.001, 0.0001, self.nb_df, dtype=np.float32)
        ustate = lfilter([1.0 - a], [1.0, -a], mag, axis=0, zi=(a * init_u)[None, :])[0]
        feat_cpx = (cpx / np.sqrt(ustate)).astype(np.complex64)
        return feat_erb, feat_cpx

    def _shift(self, x: np.ndarray, axis: int) -> np.ndarray:
        """``ConstantPad2d((0, 0, -L, L))``: look ``L`` frames ahead."""
        la = self.conv_lookahead
        if la == 0:
            return x
        out = np.zeros_like(x)
        src = [slice(None)] * x.ndim
        dst = [slice(None)] * x.ndim
        src[axis] = slice(la, None)
        dst[axis] = slice(0, x.shape[axis] - la)
        out[tuple(dst)] = x[tuple(src)]
        return out

    # ----------------------------------------------------------------- model

    def infer(self, spec: np.ndarray) -> np.ndarray:
        """Run the network on one channel's spectrum ``[T, F]``; returns ``(erb_mask, df_coefs)``."""
        feat_erb, feat_cpx = self.features(spec)
        t = spec.shape[0]
        fe = self._shift(feat_erb, 0)[None, None]  # [1, 1, T, E]
        fs = np.stack([feat_cpx.real, feat_cpx.imag], axis=0).astype(np.float32)  # [2, T, F']
        fs = self._shift(fs, 1)[None]  # [1, 2, T, F']
        e0, e1, e2, e3, emb, c0, _lsnr = self._sessions["enc"].run(None, {"feat_erb": fe, "feat_spec": fs})
        (m,) = self._sessions["erb_dec"].run(None, {"emb": emb, "e3": e3, "e2": e2, "e1": e1, "e0": e0})
        coefs = self._sessions["df_dec"].run(["coefs"], {"emb": emb, "c0": c0})[0]
        mask = m[0, 0]  # [T, E]
        coefs = coefs[0].reshape(t, self.nb_df, self.df_order, 2)
        coefs = (coefs[..., 0] + 1j * coefs[..., 1]).astype(np.complex64)  # [T, F', O]
        return mask, coefs

    def apply(self, spec: np.ndarray, mask: np.ndarray, coefs: np.ndarray) -> np.ndarray:
        gains = mask[:, self.band_of_bin]  # [T, F]
        spec_m = spec * gains
        # Deep filtering: y[t] = sum_n x[t - (order-1-lookahead) + n] * c[t, n]
        o, la = self.df_order, self.df_lookahead
        low = spec[:, : self.nb_df]
        pad = np.pad(low, ((o - 1 - la, la), (0, 0)))
        t = spec.shape[0]
        y = np.zeros_like(low)
        for n in range(o):
            y += pad[n:n + t] * coefs[:, :, n]
        out = spec_m.copy()
        out[:, : self.nb_df] = y
        return out

    def enhance(self, audio: np.ndarray, atten_lim_db: float | None = None,
                link_channels: bool = True) -> np.ndarray:
        """Enhance ``[C, N]`` audio at 48 kHz; output has the same shape."""
        c, orig_len = audio.shape
        pad_end = self.n_fft + (-(orig_len + self.n_fft)) % self.hop
        specs, masks, coefs = [], [], []
        for ch in range(c):
            x = np.concatenate([audio[ch].astype(np.float32), np.zeros(pad_end, dtype=np.float32)])
            spec = self.analysis(x)
            m, cf = self.infer(spec)
            specs.append(spec)
            masks.append(m)
            coefs.append(cf)
        if link_channels and c > 1:
            shared = np.mean(masks, axis=0)
            masks = [shared] * c
        out = np.zeros((c, orig_len), dtype=np.float32)
        d = self.n_fft - self.hop
        lim = None
        if atten_lim_db is not None and abs(atten_lim_db) > 0:
            lim = 10.0 ** (-abs(atten_lim_db) / 20.0)
        for ch in range(c):
            enh = self.apply(specs[ch], masks[ch], coefs[ch])
            if lim is not None:
                enh = specs[ch] * lim + enh * (1.0 - lim)
            y = self.synthesis(enh)
            out[ch] = y[d:d + orig_len]
        return out


def enhance_audio(
    model: DeepFilterNet,
    audio: np.ndarray,
    sr: int,
    atten_lim_db: float | None,
    link_channels: bool = True,
    chunk_seconds: float = 20.0,
    on_progress: Callable[[float], None] | None = None,
) -> np.ndarray:
    """Resample to 48 kHz if needed, run DeepFilterNet chunk-wise, resample back."""
    x = resample(audio, sr, SR) if sr != SR else audio
    chunk = int(chunk_seconds * SR)
    context = int(2.0 * SR)  # recurrent state & normalisation warm-up
    y = process_chunked(
        x,
        lambda seg: model.enhance(seg, atten_lim_db=atten_lim_db, link_channels=link_channels),
        chunk=chunk, context=context, fade=int(0.5 * SR), on_progress=on_progress,
    )
    return resample(y, SR, sr) if sr != SR else y
