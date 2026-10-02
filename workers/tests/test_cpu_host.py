"""On a server without a GPU: what is offered, and what transcription uses."""

import sys
import types

import pytest

from workers.strategies.image import realesrgan
from workers.strategies.video import realesrgan as video_realesrgan


@pytest.fixture
def ml_installed(monkeypatch):
    """As if torch and cv2 were importable and the weights reachable - so only the GPU decides."""
    monkeypatch.setattr(realesrgan.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setattr(realesrgan, "_weights_reachable", lambda: True)
    monkeypatch.delenv("ALLOW_CPU_UPSCALE", raising=False)


def test_upscaling_is_offered_as_unavailable_without_a_gpu(ml_installed, monkeypatch):
    monkeypatch.setattr(realesrgan, "gpu_present", lambda: False)
    assert realesrgan.RealEsrgan.available() is False
    info = realesrgan.RealEsrgan.info()
    assert info.available is False
    assert "needs a GPU" in info.unavailable_reason
    assert "Sharpening works on any machine" in info.unavailable_reason


def test_video_upscaling_says_so_per_frame(ml_installed, monkeypatch):
    monkeypatch.setattr(realesrgan, "gpu_present", lambda: False)
    monkeypatch.setattr(video_realesrgan.vio, "ffmpeg_available", lambda: True)
    assert video_realesrgan.RealEsrganVideo.available() is False
    assert "each frame would take" in video_realesrgan.RealEsrganVideo.unavailable_reason()


def test_upscaling_runs_with_a_gpu_or_when_cpu_is_allowed(ml_installed, monkeypatch):
    monkeypatch.setattr(realesrgan, "gpu_present", lambda: True)
    assert realesrgan.RealEsrgan.available() is True
    monkeypatch.setattr(realesrgan, "gpu_present", lambda: False)
    monkeypatch.setenv("ALLOW_CPU_UPSCALE", "true")
    assert realesrgan.RealEsrgan.available() is True
    assert realesrgan.RealEsrgan.unavailable_reason() == ""


def test_whisper_defaults_to_base_without_a_gpu(monkeypatch):
    # transcribe imports numpy (audio I/O); the CI job installs only the light
    # requirements, where this test skips itself like the other ML ones.
    pytest.importorskip("numpy")
    from workers.strategies.audio import transcribe

    def fake(count):
        module = types.ModuleType("ctranslate2")
        module.get_cuda_device_count = lambda: count
        return module

    monkeypatch.setitem(sys.modules, "ctranslate2", fake(0))
    assert transcribe.default_model() == "base"
    monkeypatch.setitem(sys.modules, "ctranslate2", fake(1))
    assert transcribe.default_model() == "small"
