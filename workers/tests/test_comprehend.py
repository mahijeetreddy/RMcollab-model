from __future__ import annotations

from pathlib import Path

import pytest

# The comprehension strategy imports the audio stack (numpy, noisereduce), which
# only the GPU image installs. It runs there and skips in the light CI job.
pytest.importorskip("numpy")
pytest.importorskip("noisereduce")

from workers.common.strategies import ProducedArtifact  # noqa: E402
from workers.strategies.audio import comprehend as comp  # noqa: E402

pytestmark = pytest.mark.ml


def noop(fraction: float, message: str | None = None) -> None:
    pass


@pytest.fixture
def stubbed(monkeypatch, tmp_path: Path):
    """Whisper and the language model are replaced, so these tests exercise the
    pipeline's decisions - what runs, in what order, what survives a failure -
    rather than the models."""
    calls: dict[str, int] = {"transcribe": 0, "summarise": 0, "denoise": 0}
    seen: dict[str, Path] = {}

    def fake_transcribe(source, transcript_path, params, progress, *, base=0.0, span=1.0):
        calls["transcribe"] += 1
        seen["source"] = Path(source)
        transcript_path.write_text("[00:00:00] we agreed to ship on friday\n", encoding="utf-8")
        return ProducedArtifact(path=transcript_path, kind="transcript", label="Transcript",
                                mime_type="text/plain", meta={"segments": 1, "durationS": seen.get("duration", 60)})

    def fake_summarise(text, progress, *, base=0.0, span=1.0, chapters=False):
        calls["summarise"] += 1
        seen["chapters"] = chapters
        return "- **Decisions**: ship on friday", {"provider": "stub", "chunks": 1}

    class FakeGate:
        def enhance(self, input_path, output_path, params, progress):
            calls["denoise"] += 1
            output_path.write_bytes(b"RIFF")
            from workers.common.strategies import EnhanceResult
            return EnhanceResult(output_path=output_path)

    monkeypatch.setattr(comp, "transcribe_file", fake_transcribe)
    monkeypatch.setattr(comp, "summarise_text", fake_summarise)
    monkeypatch.setattr(comp, "SpectralGate", FakeGate)
    monkeypatch.setattr(comp.llm, "available", lambda *_: True)

    source = tmp_path / "original.mp3"
    source.write_bytes(b"ID3")
    return calls, seen, source, tmp_path / "enhanced.mp3"


def run(source, output, **params):
    return comp.TranscribeAndSummarise().enhance(source, output, params, noop)


class TestComprehension:
    def test_produces_a_transcript_and_a_summary(self, stubbed):
        calls, _, source, output = stubbed
        result = run(source, output)
        assert [a.kind for a in result.artifacts] == ["transcript", "summary"]
        assert calls == {"transcribe": 1, "summarise": 1, "denoise": 0}

    def test_without_a_language_model_it_still_returns_the_transcript(self, stubbed, monkeypatch):
        calls, _, source, output = stubbed
        monkeypatch.setattr(comp.llm, "available", lambda *_: False)
        result = run(source, output)
        assert [a.kind for a in result.artifacts] == ["transcript"]
        assert calls["summarise"] == 0
        assert "no language model configured" in result.message

    def test_a_failed_summary_keeps_the_transcript(self, stubbed, monkeypatch):
        # The reason this runs as one job with several artifacts rather than a
        # chain: a summary failure must not discard a transcript that worked.
        _, _, source, output = stubbed

        def broken(text, progress, *, base=0.0, span=1.0, chapters=False):
            raise RuntimeError("rate limited")

        monkeypatch.setattr(comp, "summarise_text", broken)
        result = run(source, output)
        assert [a.kind for a in result.artifacts] == ["transcript"]
        assert "summary failed" in result.message
        assert "rate limited" in result.message

    def test_does_not_denoise_by_default(self, stubbed):
        # Measured: denoising before Whisper raised word error rate. See the
        # workers README for the table.
        calls, seen, source, output = stubbed
        result = run(source, output)
        assert calls["denoise"] == 0
        assert seen["source"] == source
        assert result.artifacts[0].meta["denoised"] is False

    def test_denoise_is_available_as_an_opt_in(self, stubbed):
        calls, seen, source, output = stubbed
        result = run(source, output, denoise=True)
        assert calls["denoise"] == 1
        assert seen["source"].name == "denoised.wav"
        assert result.artifacts[0].meta["denoised"] is True

    @pytest.mark.parametrize("value", ["false", "0", "off", "no"])
    def test_string_falsy_values_disable_denoise(self, stubbed, value):
        # Params arrive from a multipart form, so booleans come in as strings.
        calls, _, source, output = stubbed
        run(source, output, denoise=value)
        assert calls["denoise"] == 0

    def test_is_the_audio_default(self):
        from workers.common.strategies import default_strategy, load_strategies

        load_strategies(("audio",))
        assert default_strategy("audio").name == "comprehend"

    def test_chapters_only_for_recordings_long_enough_to_need_them(self, stubbed):
        _, seen, source, output = stubbed
        seen["duration"] = 3 * 60
        run(source, output)
        assert seen["chapters"] is False
        seen["duration"] = comp.CHAPTERS_MIN_S + 1
        run(source, output)
        assert seen["chapters"] is True
