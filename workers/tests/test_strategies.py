from __future__ import annotations

from pathlib import Path

import pytest

from workers.common.strategies import (
    BaseEnhancer,
    EnhanceResult,
    ProducedArtifact,
    StrategyError,
    StrategyNotFound,
    default_strategy,
    get_strategy,
    list_strategies,
    register,
    resolve_strategy,
)

# Video has no strategies loaded in these tests, so the registry for it starts
# empty and every assertion is about the classes defined here.
MEDIA = "video"


def make(name: str, *, available: bool = True, media_type: str = MEDIA) -> type[BaseEnhancer]:
    class Fake(BaseEnhancer):
        def enhance(self, input_path, output_path, params, progress):
            return EnhanceResult(output_path=output_path)

        @classmethod
        def available(cls) -> bool:
            return available

    Fake.name = name
    Fake.media_type = media_type  # type: ignore[assignment]
    Fake.__qualname__ = f"Fake_{name}"
    return Fake


@pytest.fixture(autouse=True)
def video_registry_is_ours():
    # Mark video as loaded so resolution never imports the real ffmpeg/torch
    # strategies, which are not installed in the light test image.
    from workers.common import strategies as registry

    registry._LOADED.add(MEDIA)


class TestRegistration:
    def test_registers_and_is_retrievable(self):
        cls = register(make("alpha"))
        assert get_strategy(MEDIA, "alpha") is cls

    def test_first_registered_becomes_default(self):
        register(make("alpha"))
        register(make("beta"))
        assert default_strategy(MEDIA).name == "alpha"

    def test_explicit_default_wins_over_registration_order(self):
        register(make("alpha"))
        register(default=True)(make("beta"))
        assert default_strategy(MEDIA).name == "beta"

    def test_two_explicit_defaults_is_an_error(self):
        register(default=True)(make("alpha"))
        with pytest.raises(StrategyError, match="two defaults"):
            register(default=True)(make("beta"))

    def test_duplicate_name_is_an_error(self):
        register(make("alpha"))
        with pytest.raises(StrategyError, match="duplicate"):
            register(make("alpha"))

    def test_empty_name_is_rejected(self):
        with pytest.raises(StrategyError, match="name"):
            register(make(""))

    def test_unknown_media_type_is_rejected(self):
        with pytest.raises(StrategyError, match="media_type"):
            register(make("alpha", media_type="hologram"))

    def test_abstract_enhance_is_rejected(self):
        class NoEnhance(BaseEnhancer):
            name = "incomplete"
            media_type = MEDIA  # type: ignore[assignment]

        with pytest.raises(StrategyError, match="enhance"):
            register(NoEnhance)

    def test_unknown_name_lookup_raises(self):
        with pytest.raises(StrategyNotFound):
            get_strategy(MEDIA, "nope")


class TestAvailabilityAwareDefaults:
    def test_unavailable_declared_default_yields_to_an_available_one(self):
        # A strategy whose API key or weights are missing must never be the
        # thing a job silently runs by default.
        register(default=True)(make("needs_key", available=False))
        register(make("offline"))
        assert default_strategy(MEDIA).name == "offline"

    def test_listing_marks_the_resolved_default_not_the_declared_one(self):
        register(default=True)(make("needs_key", available=False))
        register(make("offline"))
        info = {i.name: i for i in list_strategies(MEDIA)}
        assert info["offline"].is_default is True
        assert info["needs_key"].is_default is False
        assert info["needs_key"].available is False


class TestResolution:
    def test_named_available_strategy_runs_as_requested(self):
        register(make("alpha"))
        register(make("beta"))
        result = resolve_strategy(MEDIA, "beta")
        assert result.name == "beta"
        assert result.fell_back is False

    def test_auto_runs_the_default_without_reporting_a_fallback(self):
        register(make("alpha"))
        result = resolve_strategy(MEDIA, "auto")
        assert result.name == "alpha"
        assert result.fell_back is False

    def test_unknown_name_falls_back_and_says_why(self):
        register(make("alpha"))
        result = resolve_strategy(MEDIA, "ghost")
        assert result.name == "alpha"
        assert result.fell_back is True
        assert "not registered" in (result.reason or "")

    def test_unavailable_name_falls_back_and_says_why(self):
        register(make("alpha"))
        register(make("needs_key", available=False))
        result = resolve_strategy(MEDIA, "needs_key")
        assert result.name == "alpha"
        assert result.fell_back is True
        assert "not configured" in (result.reason or "")


class TestEnhanceResultArtifacts:
    def test_single_output_is_wrapped_as_one_enhanced_artifact(self):
        produced = EnhanceResult(output_path=Path("/x/enhanced.png")).produced()
        assert len(produced) == 1
        assert produced[0].kind == "enhanced"
        assert produced[0].path == Path("/x/enhanced.png")

    def test_explicit_artifacts_are_returned_unchanged(self):
        items = [
            ProducedArtifact(path=Path("/x/t.txt"), kind="transcript", label="Transcript"),
            ProducedArtifact(path=Path("/x/s.md"), kind="summary", label="Summary"),
        ]
        produced = EnhanceResult(artifacts=items).produced()
        assert [a.kind for a in produced] == ["transcript", "summary"]

    def test_artifacts_take_precedence_over_output_path(self):
        items = [ProducedArtifact(path=Path("/x/t.txt"), kind="transcript")]
        produced = EnhanceResult(output_path=Path("/x/o.png"), artifacts=items).produced()
        assert [a.kind for a in produced] == ["transcript"]

    def test_no_output_at_all_produces_nothing(self):
        assert EnhanceResult().produced() == []


class TestFallback:
    def test_the_declared_fallback_runs_when_the_default_cannot(self):
        register(default=True)(make("needs-a-model", available=False))
        register(make("first-loaded"))
        register(fallback=True)(make("preferred"))
        assert default_strategy(MEDIA).name == "preferred"

    def test_the_default_still_wins_when_it_can_run(self):
        register(default=True)(make("default"))
        register(fallback=True)(make("preferred"))
        assert default_strategy(MEDIA).name == "default"

    def test_an_unavailable_fallback_falls_through_to_anything_available(self):
        register(default=True)(make("needs-a-model", available=False))
        register(fallback=True)(make("also-down", available=False))
        register(make("still-up"))
        assert default_strategy(MEDIA).name == "still-up"

    def test_two_fallbacks_for_one_media_type_are_rejected(self):
        register(fallback=True)(make("one"))
        with pytest.raises(StrategyError, match="two fallbacks"):
            register(fallback=True)(make("two"))
