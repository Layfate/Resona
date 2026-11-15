import numpy as np
import pytest
from conftest import sine, snr_db

from resona_worker.dsp import bandwidth, chunking, declip, dehiss, limiter, loudness
from resona_worker.dsp.resample import resample
from resona_worker.dsp.stft import Stft

# ----------------------------------------------------------------- loudness

def test_lufs_mono_full_scale_sine():
    # BS.1770: a 0 dBFS 997 Hz sine in one channel reads -3.01 LUFS.
    x = sine(997.0, 5.0, 48000, amp=1.0, channels=1)
    assert loudness.integrated_loudness(x, 48000) == pytest.approx(-3.01, abs=0.05)


@pytest.mark.parametrize("sr", [44100, 48000, 96000])
def test_lufs_ebu3341_stereo_minus23(sr):
    # EBU Tech 3341 case 1: stereo 1 kHz sine at -23 dBFS reads -23.0 LUFS.
    x = sine(1000.0, 20.0, sr, amp=10 ** (-23 / 20), channels=2)
    assert loudness.integrated_loudness(x, sr) == pytest.approx(-23.0, abs=0.1)


def test_lufs_gating_ignores_silence():
    sr = 48000
    tone = sine(1000.0, 10.0, sr, amp=10 ** (-23 / 20), channels=2)
    padded = np.concatenate([tone, np.zeros((2, sr * 10), np.float32)], axis=1)
    assert loudness.integrated_loudness(padded, sr) == pytest.approx(-23.0, abs=0.1)


def test_true_peak_detects_intersample_overs():
    sr = 48000
    # fs/4 sine phase-shifted by 45°: samples peak at 0.707 * amp, true peak = amp.
    n = np.arange(sr)
    x = np.sin(2 * np.pi * n / 4 + np.pi / 4).astype(np.float32)[None, :]
    assert float(np.abs(x).max()) == pytest.approx(0.7071, abs=1e-3)
    assert loudness.true_peak(x) == pytest.approx(1.0, abs=0.02)


# ------------------------------------------------------------------ limiter

def test_limiter_respects_ceiling_and_leaves_quiet_audio():
    sr = 48000
    rng = np.random.default_rng(0)
    x = (rng.standard_normal((2, sr * 3)) * 0.4).astype(np.float32)
    y, red = limiter.limit(x, sr, ceiling_db=-1.0)
    assert loudness.true_peak(y) <= 10 ** (-1.0 / 20) + 1e-3
    assert red > 0
    quiet = x * 0.1
    y2, red2 = limiter.limit(quiet, sr, ceiling_db=-1.0)
    assert red2 == 0.0 and np.array_equal(y2, quiet)


def test_limiter_is_channel_linked():
    sr = 48000
    x = sine(440.0, 1.0, sr, amp=1.5, channels=2)
    x[1] *= 0.5
    y, _ = limiter.limit(x, sr, -1.0)
    ratio = y[1] / np.where(np.abs(y[0]) > 1e-3, y[0], np.nan)
    assert np.nanmax(np.abs(ratio - 0.5)) < 1e-3  # identical gain on both channels


# -------------------------------------------------------------------- STFT

@pytest.mark.parametrize("n", [1000, 4096, 48000 + 17])
def test_stft_perfect_reconstruction(n):
    rng = np.random.default_rng(1)
    x = rng.standard_normal((2, n)).astype(np.float32)
    s = Stft(2048, 512)
    y = s.inverse(s.forward(x), n)
    assert y.shape == x.shape
    assert np.max(np.abs(x - y)) < 1e-4


# ----------------------------------------------------------------- chunking

def test_chunking_identity_is_seamless():
    rng = np.random.default_rng(2)
    x = rng.standard_normal((2, 100_003)).astype(np.float32)
    y = chunking.process_chunked(x, lambda s: s * 1.0, chunk=10_000, context=2_000, fade=1_000)
    assert np.max(np.abs(x - y)) < 1e-5


def test_chunking_context_hides_edge_effects():
    # A filter with edge transients: chunked result must match whole-file result.
    from scipy.signal import butter, filtfilt

    b, a = butter(4, 0.1)
    rng = np.random.default_rng(3)
    x = rng.standard_normal((1, 60_000)).astype(np.float32)
    fn = lambda s: filtfilt(b, a, s, axis=-1).astype(np.float32)  # noqa: E731
    whole = fn(x)
    chunked = chunking.process_chunked(x, fn, chunk=8_000, context=3_000, fade=1_000)
    assert snr_db(whole, chunked) > 60


# --------------------------------------------------------------- resampling

@pytest.mark.parametrize("sr_in,sr_out", [(44100, 48000), (48000, 44100), (22050, 48000), (48000, 96000)])
def test_resample_preserves_duration_and_tone(sr_in, sr_out):
    x = sine(1000.0, 2.0, sr_in, amp=0.5, channels=2)
    y = resample(x, sr_in, sr_out)
    assert y.shape == (2, int(round(x.shape[1] * sr_out / sr_in)))
    ref = sine(1000.0, 2.0, sr_out, amp=0.5, channels=2)[:, : y.shape[1]]
    mid = slice(1000, y.shape[1] - 1000)
    assert snr_db(ref[:, mid], y[:, mid]) > 50


# ------------------------------------------------------------------ declip

def _music_like(sr=44100, seconds=1.5, seed=4):
    rng = np.random.default_rng(seed)
    t = np.arange(int(sr * seconds)) / sr
    x = sum(np.sin(2 * np.pi * f * t + rng.uniform(0, 6)) / (i + 1) for i, f in enumerate((180, 410, 950, 2200)))
    return (x / np.max(np.abs(x))).astype(np.float32)[None, :]


def test_declip_detects_and_improves_snr():
    clean = _music_like()
    clipped = np.clip(clean * 1.0, -0.6, 0.6)
    stats = declip.detect(clipped)
    assert stats.is_clipped
    assert not declip.detect(clean * 0.9).is_clipped
    restored, n = declip.declip(clipped)
    assert n > 0
    before = snr_db(clean, clipped)
    after = snr_db(clean, restored)
    assert after > before + 6.0, (before, after)
    # Unclipped samples are untouched.
    mask, _, _ = declip.clip_mask(clipped[0])
    assert np.array_equal(restored[0][~mask], clipped[0][~mask])


def _chord_attack(sr=44100, seconds=0.4):
    """Harmonic-rich chord attack (F major, ~40 partials each, fast decay)."""
    t = np.arange(int(sr * seconds)) / sr
    env = np.minimum(1, t / 0.02) * np.exp(-t * 0.6)
    x = np.zeros_like(t)
    for k, f in enumerate((174.61, 220.0, 261.63)):
        for h in range(1, 40):
            if f * h > 20000:
                break
            x += 0.5 / h**1.1 * (0.5 + 0.3 * np.sin(k + h)) * np.sin(2 * np.pi * f * h * t + h) * env
    return (x / np.max(np.abs(x))).astype(np.float32)


def test_declip_never_spikes_far_beyond_true_peak():
    # Regression: a near-unstable AR model used to turn one clipped run of this
    # signal into a spike at the 4x safety clamp (true peak 1.4x), which the
    # limiter then had to squash, damaging the whole file.
    clean = _chord_attack()
    gain = 10 ** (3 / 20)
    ref = clean * gain * 0.99
    clipped = (np.clip(clean * gain, -1, 1) * 0.99).astype(np.float32)
    restored, n = declip.declip_channel(clipped)
    assert n > 0
    assert np.max(np.abs(restored)) < 1.5 * np.max(np.abs(ref))
    mask, _, _ = declip.clip_mask(clipped)
    assert np.sum((restored[mask] - ref[mask]) ** 2) < np.sum((clipped[mask] - ref[mask]) ** 2)


def test_declip_no_op_on_clean_audio():
    clean = _music_like() * 0.8
    out, n = declip.declip(clean)
    assert n == 0 and np.array_equal(out, clean)


# ------------------------------------------------------------------ de-hiss

def test_dehiss_reduces_stationary_noise_and_keeps_signal():
    sr = 44100
    rng = np.random.default_rng(5)
    clean = np.concatenate([np.zeros((1, sr)), _music_like(sr, 4.0) * 0.5], axis=1).astype(np.float32)
    noise = (rng.standard_normal(clean.shape) * 0.01).astype(np.float32)
    noisy = clean + noise
    prof = dehiss.estimate_noise_profile(noisy, sr)
    out = dehiss.apply(noisy, prof, strength=0.6)
    assert out.shape == noisy.shape
    assert snr_db(clean, out) > snr_db(clean, noisy) + 3.0
    # Noise in the silent lead-in is attenuated by at least 6 dB.
    lead = slice(2000, sr - 2000)
    assert np.std(out[0, lead]) < np.std(noisy[0, lead]) * 0.5


# --------------------------------------------------------------- bandwidth

def _lowpassed_noise(sr, cutoff, seconds=4.0, seed=6):
    from scipy.signal import ellip, sosfiltfilt

    rng = np.random.default_rng(seed)
    x = rng.standard_normal((2, int(sr * seconds))).astype(np.float32) * 0.1
    sos = ellip(10, 0.1, 90, cutoff, fs=sr, output="sos")  # codec-like brick wall
    return sosfiltfilt(sos, x, axis=-1).astype(np.float32)


def test_detect_cutoff_mp3_like():
    sr = 44100
    x = _lowpassed_noise(sr, 16000)
    cut = bandwidth.detect_cutoff(x, sr)
    assert cut["bandLimited"]
    assert 15000 < cut["cutoffHz"] < 17000


def test_detect_cutoff_full_band():
    rng = np.random.default_rng(7)
    x = rng.standard_normal((2, 44100 * 3)).astype(np.float32) * 0.1
    assert not bandwidth.detect_cutoff(x, 44100)["bandLimited"]


def test_extend_adds_energy_only_above_cutoff():
    sr = 44100
    x = _lowpassed_noise(sr, 11000)
    y = bandwidth.extend(x, sr, 11000, strength=0.6)
    assert y.shape == x.shape
    X = np.abs(np.fft.rfft(x[0]))
    Y = np.abs(np.fft.rfft(y[0]))
    f = np.fft.rfftfreq(x.shape[1], 1 / sr)
    low = f < 10000
    high = (f > 12500) & (f < 20000)
    assert np.allclose(X[low], Y[low], rtol=0.02, atol=0.01 * X[low].mean())
    assert Y[high].mean() > 10 * X[high].mean()
    # Synthesised band stays below the in-band level.
    assert Y[high].mean() < X[(f > 6000) & (f < 10000)].mean()


def test_detect_cutoff_on_real_mp3_encodes(tmp_path):
    """Round-trip through libsndfile's LAME encoder: lower bitrates cut off lower."""
    import soundfile as sf

    from resona_worker.benchmark import synthetic_music

    sr = 44100
    rng = np.random.default_rng(0)
    w = rng.standard_normal((2, sr * 6))
    spec = np.fft.rfft(w, axis=-1)
    f = np.fft.rfftfreq(w.shape[1], 1 / sr)
    spec[:, 1:] /= np.sqrt(f[1:])  # pink noise: broadband like real music
    pink = np.fft.irfft(spec, axis=-1)
    x = (pink / np.abs(pink).max() * 0.3 + synthetic_music(6, sr) * 0.5).astype(np.float32)
    assert not bandwidth.detect_cutoff(x, sr)["bandLimited"]
    cutoffs = []
    for level in (0.9, 0.5):  # lower quality first
        p = tmp_path / f"q{level}.mp3"
        with sf.SoundFile(p, "w", samplerate=sr, channels=2, format="MP3", subtype="MPEG_LAYER_III",
                          compression_level=level, bitrate_mode="CONSTANT") as fh:
            for a in range(0, x.shape[1], 16384):
                fh.write(x.T[a:a + 16384])
        y, _ = sf.read(p, dtype="float32", always_2d=True)
        cut = bandwidth.detect_cutoff(y.T, sr)
        assert cut["bandLimited"], cut
        cutoffs.append(cut["cutoffHz"])
    assert 8000 < cutoffs[0] < cutoffs[1] < 21000


def test_noise_floor_only_reported_with_quiet_passages():
    from resona_worker.analysis import noise_floor_db

    sr = 44100
    rng = np.random.default_rng(9)
    dense = _music_like(sr, 6.0) * 0.5
    assert noise_floor_db(dense, sr) is None
    hiss = (rng.standard_normal((1, sr * 3)) * 10 ** (-50 / 20)).astype(np.float32)
    with_pause = np.concatenate([dense, hiss + 0.0], axis=1)
    nf = noise_floor_db(with_pause, sr)
    assert nf is not None and -54 < nf < -46
