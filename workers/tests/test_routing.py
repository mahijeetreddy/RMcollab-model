"""Capability routing: which pool serves a strategy, and how defaults merge."""

from __future__ import annotations

import sys

import pytest

from workers.common import strategies as registry
from workers.common.advertise import serving_queue
from workers.common.strategies import (
    BaseEnhancer,
    EnhanceResult,
    load_strategies,
    register,
    registered_strategies,
    restrict_loading,
)


def fake(name: str, media_type: str) -> type[BaseEnhancer]:
    class Fake(BaseEnhancer):
        def enhance(self, input_path, output_path, params, progress):
            return EnhanceResult(output_path=output_path)

    Fake.name = name
    Fake.media_type = media_type  # type: ignore[assignment]
    Fake.__qualname__ = f"Fake_{name}"
    return Fake


class TestServingQueue:
    def test_a_strategy_in_its_own_pool_is_served_on_its_media_queue(self):
        assert serving_queue("video", ("enhance.video",)) == "enhance.video"

    def test_a_strategy_hosted_by_another_pool_is_served_on_that_pools_queue(self):
        # Video comprehension registered by the audio pool must be sent to the
        # audio queue, or the video pool - which cannot run it - would get it.
        assert serving_queue("video", ("enhance.audio",)) == "enhance.audio"

    def test_a_pool_draining_several_queues_prefers_the_media_types_own(self):
        assert serving_queue("video", ("enhance.audio", "enhance.video")) == "enhance.video"


class TestLoadingScope:
    def test_an_out_of_scope_package_is_never_imported(self, monkeypatch):
        # The audio pool resolving a video job must not import Real-ESRGAN.
        registry._LOADED.discard("image")
        for name in [m for m in sys.modules if m.startswith("workers.strategies.image")]:
            monkeypatch.delitem(sys.modules, name)
        restrict_loading(("text",))
        load_strategies(("image",))
        assert "image" not in registry._LOADED
        assert not any(m.startswith("workers.strategies.image") for m in sys.modules)

    def test_in_scope_packages_still_load(self):
        registry._LOADED.discard("text")
        restrict_loading(("text",))
        load_strategies(("text",))
        assert "text" in registry._LOADED


class TestAdvertisedDefaults:
    def test_a_declared_default_is_flagged_explicit(self):
        register(default=True)(fake("declared", "video"))
        register(fake("other", "video"))
        infos = {i.name: i for i in registered_strategies() if i.media_type == "video"}
        assert infos["declared"].explicit_default is True
        assert infos["other"].explicit_default is False

    def test_a_pools_fallback_default_is_not_explicit(self):
        # The video pool alone has no declared default; its classical fallback
        # must lose to the audio pool's declared one when the gateway merges.
        register(fake("fallback", "video"))
        info = next(i for i in registered_strategies() if i.name == "fallback")
        assert info.is_default is True
        assert info.explicit_default is False

    def test_listing_what_is_registered_imports_nothing(self, monkeypatch):
        calls = []
        monkeypatch.setattr(registry, "load_strategies", lambda *a, **k: calls.append(a))
        registered_strategies()
        assert calls == []


class TestVideoComprehension:
    @pytest.fixture
    def video_comprehend(self):
        pytest.importorskip("numpy")
        pytest.importorskip("noisereduce")
        from workers.strategies.audio import comprehend_video

        return comprehend_video

    pytestmark = pytest.mark.ml

    def test_it_registers_as_video_from_the_audio_package(self, video_comprehend):
        # The registry is reset between tests and a module registers only on its
        # first import, so register explicitly rather than rely on import order.
        cls = video_comprehend.VideoTranscribeAndSummarise
        register(default=True)(cls)
        assert (cls.media_type, cls.name) == ("video", "comprehend")
        assert registry.owning_package(cls) == "audio"
        assert registry._EXPLICIT_DEFAULTS["video"] == "comprehend"
        advertised = {(i.media_type, i.name) for i in registered_strategies(owned_by=("audio",))}
        assert ("video", "comprehend") in advertised

    def test_a_silent_video_gets_a_plain_message(self, video_comprehend, monkeypatch, tmp_path):
        def no_audio(path):
            raise video_comprehend.aio.AudioIOError(f"no audio stream in {path.name}")

        monkeypatch.setattr(video_comprehend.aio, "probe", no_audio)
        clip = tmp_path / "screen-recording.mp4"
        clip.write_bytes(b"")
        with pytest.raises(ValueError, match="no soundtrack"):
            video_comprehend.VideoTranscribeAndSummarise().enhance(clip, tmp_path / "out", {}, lambda *a: None)


class TestOwnership:
    def test_a_strategy_is_owned_by_the_package_it_is_defined_in(self):
        cls = fake("x", "video")
        cls.__module__ = "workers.strategies.audio.comprehend_video"
        assert registry.owning_package(cls) == "audio"

    def test_a_pool_advertises_only_what_its_own_packages_define(self):
        # Regression: the video pool imports image Real-ESRGAN for upscaling,
        # which registers the image strategies there too. Advertised, they
        # overwrote the image pool's adverts and routed image jobs to video.
        imported = fake("upscale", "image")
        imported.__module__ = "workers.strategies.image.realesrgan"
        hosted = fake("comprehend", "video")
        hosted.__module__ = "workers.strategies.audio.comprehend_video"
        register(imported)
        register(hosted)
        names = {(i.media_type, i.name) for i in registered_strategies(owned_by=("audio",))}
        assert ("video", "comprehend") in names
        assert ("image", "upscale") not in names
