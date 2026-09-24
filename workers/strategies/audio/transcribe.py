from __future__ import annotations

import importlib.util
import logging
import os
import time
from functools import lru_cache
from pathlib import Path
from typing import Any

from workers.common.strategies import (
    BaseEnhancer,
    EnhanceResult,
    ProducedArtifact,
    ProgressFn,
    register,
)
from workers.strategies.audio import _audio_io as aio

log = logging.getLogger(__name__)

# int8 quantisation is what makes this fit: the audio pool shares one 4GB card
# with the image and video pools, so a float16 `small` alongside Real-ESRGAN's
# ~756MB working set is asking for a CUDA OOM on a busy room.
DEFAULT_MODEL = "small"
DEFAULT_COMPUTE_CUDA = "int8_float16"
DEFAULT_COMPUTE_CPU = "int8"

MAX_DURATION_S = 3 * 60 * 60


class TranscriptionUnavailable(RuntimeError):
    """faster-whisper or its model weights could not be loaded."""


def _stamp(seconds: float) -> str:
    total = int(seconds)
    return f"{total // 3600:02d}:{(total % 3600) // 60:02d}:{total % 60:02d}"


@lru_cache(maxsize=2)
def _load_model(size: str, requested_device: str | None) -> tuple[Any, str, str]:
    """Cached for the life of the worker process.

    Loading `small` costs several seconds and dominates a short job. Celery
    workers are long-lived, so the model stays resident between jobs; the cost
    is a few hundred MB of the shared card held permanently by this pool, which
    is the same trade the video pool already makes for Real-ESRGAN.
    """
    from faster_whisper import WhisperModel

    device = requested_device or "auto"
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    compute = DEFAULT_COMPUTE_CUDA if device == "cuda" else DEFAULT_COMPUTE_CPU
    try:
        return WhisperModel(size, device=device, compute_type=compute), device, compute
    except Exception as exc:  # noqa: BLE001 - CTranslate2 raises bare RuntimeErrors
        if device != "cuda":
            raise TranscriptionUnavailable(f"could not load Whisper {size}: {exc}") from exc
        # A missing cuDNN/cuBLAS in the image shows up only at load time; CPU
        # int8 is slower but keeps the job finishing instead of failing.
        log.warning("Whisper CUDA load failed (%s); falling back to CPU", exc)
        model = WhisperModel(size, device="cpu", compute_type=DEFAULT_COMPUTE_CPU)
        return model, "cpu", DEFAULT_COMPUTE_CPU


@register
class WhisperTranscribe(BaseEnhancer):
    name = "transcribe"
    label = "Transcribe (Whisper)"
    description = (
        "Speech to text with faster-whisper, producing a timestamped transcript you can read, "
        "search and quote. The starting point for turning a recording into something the room "
        "can actually use. Runs on the GPU when there is room, CPU otherwise."
    )
    media_type = "audio"

    @classmethod
    def available(cls) -> bool:
        return importlib.util.find_spec("faster_whisper") is not None

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        info = aio.probe(input_path)
        if info.duration_s > MAX_DURATION_S:
            raise ValueError(
                f"{info.duration_s / 60:.0f} minute recording is over the "
                f"{MAX_DURATION_S // 3600} hour limit"
            )

        size = str(params.get("model") or os.getenv("WHISPER_MODEL") or DEFAULT_MODEL)
        progress(0.04, f"loading Whisper {size}")
        model, device, compute = _load_model(size, params.get("device"))

        progress(0.1, f"transcribing {info.duration_s:.0f}s on {device}")
        segments, detected = model.transcribe(
            str(input_path),
            beam_size=int(params.get("beam_size") or 5),
            vad_filter=bool(params.get("vad", True)),
            language=params.get("language") or None,
        )

        # `segments` is a generator: the work happens as it is consumed, which is
        # what makes real progress possible instead of one long silent block.
        total = max(detected.duration or info.duration_s, 0.001)
        lines: list[str] = []
        count = 0
        for segment in segments:
            text = segment.text.strip()
            if text:
                lines.append(f"[{_stamp(segment.start)}] {text}")
                count += 1
            progress(
                min(0.95, 0.1 + 0.85 * (segment.end / total)),
                f"{_stamp(segment.end)} / {_stamp(total)}",
            )

        if not lines:
            raise TranscriptionUnavailable("no speech detected in this recording")

        transcript = output_path.with_name("transcript.txt")
        transcript.write_text("\n".join(lines) + "\n", encoding="utf-8")

        elapsed = time.monotonic() - started
        return EnhanceResult(
            artifacts=[
                ProducedArtifact(
                    path=transcript,
                    kind="transcript",
                    label="Transcript",
                    mime_type="text/plain",
                    # Timings live inline in the file rather than here: a
                    # long recording has hundreds of segments, and meta rides
                    # along on every WS job event and room snapshot.
                    meta={
                        "language": detected.language,
                        "languageProbability": round(detected.language_probability or 0, 3),
                        "durationS": round(total, 2),
                        "segments": count,
                        "model": size,
                        "device": device,
                        "computeType": compute,
                        "realTimeFactor": round(elapsed / total, 3),
                    },
                )
            ],
            message=(
                f"transcribed {_stamp(total)} of {detected.language} audio "
                f"into {count} segments on {device} ({elapsed:.0f}s)"
            ),
            metrics={"seconds": round(elapsed, 2), "device": device, "model": size},
        )
