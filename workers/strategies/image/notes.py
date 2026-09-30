"""Image to notes: a photo of a whiteboard, slide or page becomes structured text.

A study group photographs the board at the end of a session or a slide it wants
to keep; what it needs afterwards is the content, in its notes and searchable,
not a sharper picture. So the image goes to a vision model, and what comes back
is a Markdown `summary` artifact - the same shape a recording's summary has, so
the room's notes, the library and search all take it without a new kind.

The image is sent to whichever provider LLM_VISION_* (or a Claude key) names. On
a free tier that provider may keep what it is sent, which is why this is labelled
as sending the image, and why it is only advertised when a vision model is
configured explicitly.
"""

from __future__ import annotations

import io
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

# Vision models read at around this size; a 12-megapixel phone photo sent whole
# costs upload time and tokens for detail the model downsamples away.
MAX_EDGE_PX = 1600
MAX_INPUT_BYTES = 20 * 1024 * 1024

SYSTEM = """You turn a photo of study material - a whiteboard, a slide, a page of
notes, a diagram - into notes for a study group.

Write plain Markdown with no preamble:
- Transcribe the written content faithfully, keeping its structure: headings as
  "## Heading", lists as "- item", equations and code in `backticks`.
- Describe each diagram in one or two sentences: what it shows, not how it looks.
- Mark any word you cannot read as [unclear] rather than guessing it.
- Add "## Action items" only if tasks, deadlines or to-dos are actually written.
- Invent nothing: no content, names, dates or numbers that are not in the image.

If the image is not study material (a photo of people or a place), write one
short paragraph describing it and nothing else."""

PROMPT = "Turn this image into notes."


def prepare(data: bytes) -> tuple[bytes, str]:
    """The image as a vision model should receive it: RGB, longest edge capped."""
    import cv2
    import numpy as np

    array = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if array is None:
        raise ValueError("the upload could not be read as an image")
    height, width = array.shape[:2]
    scale = MAX_EDGE_PX / max(height, width)
    if scale < 1:
        array = cv2.resize(array, (round(width * scale), round(height * scale)), interpolation=cv2.INTER_AREA)
    ok, encoded = cv2.imencode(".jpg", array, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if not ok:
        raise ValueError("the image could not be re-encoded for the model")
    return encoded.tobytes(), "image/jpeg"


@register(default=True)
class ImageNotes(BaseEnhancer):
    name = "notes"
    label = "Read into notes"
    description = (
        "Reads a whiteboard, slide or page of notes and writes its content into the room's notes: "
        "headings, points, diagrams described, action items if any are written. Sends the image to "
        "the configured vision model."
    )
    media_type = "image"

    @classmethod
    def available(cls) -> bool:
        return llm.vision_available()

    @classmethod
    def unavailable_reason(cls) -> str:
        return llm.unavailable_reason(llm.VISION)

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        raw = input_path.read_bytes()
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError(f"the image is {len(raw) // (1024 * 1024)}MB; the limit for reading is 20MB")

        progress(0.1, "preparing the image")
        data, mime = prepare(raw)

        progress(0.3, f"reading with {llm.describe(llm.VISION)}")
        result = llm.complete(SYSTEM, PROMPT, task=llm.VISION, images=(llm.Image(data, mime),))

        notes_path = output_path.parent / "notes.md"
        notes_path.write_text(result.text + "\n", encoding="utf-8")
        elapsed = time.monotonic() - started
        return EnhanceResult(
            artifacts=[
                ProducedArtifact(
                    path=notes_path,
                    kind="summary",
                    label="Notes",
                    mime_type="text/markdown",
                    meta={
                        "provider": result.provider,
                        "model": result.model,
                        "inputTokens": result.input_tokens,
                        "outputTokens": result.output_tokens,
                        "sentBytes": len(data),
                    },
                )
            ],
            message=f"read into notes by {result.model} in {elapsed:.0f}s",
            metrics={"seconds": round(elapsed, 2)},
        )
