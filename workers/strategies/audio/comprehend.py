from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any

from workers.common import llm
from workers.common.strategies import (
    BaseEnhancer,
    EnhanceResult,
    ProducedArtifact,
    ProgressFn,
    register,
)
from workers.strategies.audio.spectral import SpectralGate
from workers.strategies.audio.transcribe import transcribe_file, whisper_available
from workers.strategies.text.summarise import summarise_text

log = logging.getLogger(__name__)

# Off because denoising before Whisper was measured to make transcripts worse:
# across 5-to-(-5) dB SNR, spectral gating raised word error rate by 1.2 points on
# average and DeepFilterNet by 11.6 (at -5 dB, 21% -> 67%). Whisper is trained on
# noisy audio; a denoiser tuned for perceptual quality strips spectral detail the
# recogniser relies on. Kept as an opt-in `denoise` param, not as a default.
# Method and full table: workers/README.md.
DEFAULT_DENOISE = False

# A recording shorter than this has no use for a table of contents.
CHAPTERS_MIN_S = 8 * 60


def _truthy(value: Any, default: bool) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, str):
        return value.strip().lower() not in ("0", "false", "no", "off")
    return bool(value)


@register(default=True)
class TranscribeAndSummarise(BaseEnhancer):
    name = "comprehend"
    label = "Transcribe & summarise"
    description = (
        "Turns a recording into a timestamped transcript and a summary with key points, "
        "decisions and action items - everything a study group needs from a lecture or a "
        "meeting, shared with the room. The summary needs a language model configured; "
        "without one you still get the transcript."
    )
    media_type = "audio"

    @classmethod
    def available(cls) -> bool:
        # The transcript is the part that must work; the summary is added when a
        # model is configured, so this is available whenever Whisper is.
        return whisper_available()

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        folder = output_path.parent
        summarise = llm.available(llm.SUMMARY)
        denoise = _truthy(params.get("denoise"), DEFAULT_DENOISE)

        # Progress budget across the steps, so the room sees one bar, not three.
        transcribe_to = 0.75 if summarise else 0.98
        transcribe_from = 0.15 if denoise else 0.0

        source = input_path
        if denoise:
            progress(0.01, "reducing background noise")
            cleaned = SpectralGate().enhance(
                input_path,
                folder / "denoised.wav",
                {},
                lambda f, m=None: progress(0.01 + 0.13 * f, m or "reducing noise"),
            )
            source = Path(cleaned.output_path)  # type: ignore[arg-type]

        transcript = transcribe_file(
            source,
            folder / "transcript.txt",
            params,
            progress,
            base=transcribe_from,
            span=transcribe_to - transcribe_from,
        )
        transcript.meta["denoised"] = denoise
        artifacts: list[ProducedArtifact] = [transcript]

        # A summary failure must not throw away a transcript that already
        # succeeded - that partial result is exactly why this runs as one job
        # with several artifacts rather than as a chain of jobs.
        note = ""
        if not summarise:
            why = llm.unavailable_reason(llm.SUMMARY) or "no language model configured"
            note = f"; no summary: {why[0].lower()}{why[1:]}"
        else:
            try:
                text = transcript.path.read_text(encoding="utf-8")
                long_enough = float(transcript.meta.get("durationS") or 0) >= CHAPTERS_MIN_S
                summary, meta = summarise_text(text, progress, base=0.76, span=0.22, chapters=long_enough)
                summary_path = folder / "summary.md"
                summary_path.write_text(summary + "\n", encoding="utf-8")
                artifacts.append(
                    ProducedArtifact(
                        path=summary_path,
                        kind="summary",
                        label="Summary",
                        mime_type="text/markdown",
                        meta=meta,
                    )
                )
            except Exception as exc:  # noqa: BLE001 - keep the transcript whatever went wrong
                log.warning("summary failed for %s: %s", input_path.name, exc)
                note = (
                    f"; no summary: {str(exc)[0].lower()}{str(exc)[1:]}"
                    if isinstance(exc, llm.LLMUnavailable)
                    else f"; summary failed ({type(exc).__name__}: {exc})"
                )

        elapsed = time.monotonic() - started
        kinds = " and ".join(a.label.lower() for a in artifacts)
        return EnhanceResult(
            artifacts=artifacts,
            message=f"produced {kinds} in {elapsed:.0f}s{note}",
            metrics={
                "seconds": round(elapsed, 2),
                "denoised": denoise,
                "summarised": len(artifacts) > 1,
            },
        )
