"""DeepFilterNet3 ONNX port: regression against the official implementation."""

import numpy as np
import pytest
from conftest import FIXTURES, models_dir, requires_dfn, snr_db

from resona_worker.models.deepfilternet import DeepFilterNet, enhance_audio, erb_widths


def test_erb_widths_match_libdf():
    w = erb_widths(48000, 960, 32, 2)
    assert w.sum() == 481
    # First bands are clamped to the minimum width; last band is the widest.
    assert list(w[:8]) == [2] * 8
    assert w[-1] == w.max()


@pytest.fixture(scope="module")
def model():
    return DeepFilterNet(f"{models_dir()}/deepfilternet3", device="cpu")


@requires_dfn
@pytest.mark.parametrize("key,lim", [("full", None), ("lim12", 12.0)])
def test_matches_reference_implementation(model, key, lim):
    """Fixture = output of df.enhance.enhance (DeepFilterNet 0.5.6, PyTorch) on noisy_snr0.wav."""
    ref = np.load(FIXTURES / "dfn3_reference.npz")
    noisy = ref["noisy"].astype(np.float32)
    expected = ref[key].astype(np.float32)
    out = model.enhance(noisy, atten_lim_db=lim)
    assert out.shape == noisy.shape
    # The reference was computed on the full 10.6 s file; compare all but the tail.
    cmp = slice(0, noisy.shape[1] - 4800)
    assert snr_db(expected[:, cmp], out[:, cmp]) > 45.0


@requires_dfn
def test_reduces_noise_on_speech(model):
    # Use the reference's enhanced speech as a "clean" signal, add white noise at
    # 5 dB SNR and require a substantial SNR improvement.
    ref = np.load(FIXTURES / "dfn3_reference.npz")
    clean = ref["full"].astype(np.float32)
    rng = np.random.default_rng(0)
    noise = rng.standard_normal(clean.shape).astype(np.float32)
    noise *= np.sqrt(np.mean(clean ** 2) / np.mean(noise ** 2) / 10 ** (5 / 10))
    noisy = clean + noise
    out = model.enhance(noisy)
    before = snr_db(clean, noisy)
    after = snr_db(clean, out)
    assert before == pytest.approx(5.0, abs=0.1)
    assert after > before + 5.0, (before, after)


@requires_dfn
def test_chunked_and_resampled_matches_whole(model):
    ref = np.load(FIXTURES / "dfn3_reference.npz")
    noisy = np.tile(ref["noisy"].astype(np.float32), (2, 3))  # stereo, 6 s
    whole = model.enhance(noisy)
    chunked = enhance_audio(model, noisy, 48000, None, chunk_seconds=2.0)
    assert chunked.shape == noisy.shape
    assert snr_db(whole, chunked) > 25.0
    from resona_worker.dsp.resample import resample

    x44 = resample(noisy, 48000, 44100)
    y44 = enhance_audio(model, x44, 44100, None)
    assert y44.shape == x44.shape


@requires_dfn
def test_silence_stays_silent(model):
    out = model.enhance(np.zeros((1, 48000), np.float32))
    assert np.max(np.abs(out)) < 1e-6
