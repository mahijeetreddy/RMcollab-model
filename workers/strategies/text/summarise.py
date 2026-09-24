from __future__ import annotations

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

# Deliberately conservative: chunking on characters rather than tokens keeps this
# provider-agnostic, and the whole point of the indirection is that we do not know
# which model is behind it. ~4 chars/token puts a 24k chunk near 6k tokens, which
# every model worth using can take.
CHUNK_CHARS = 24_000
CHUNK_OVERLAP = 800
MAX_INPUT_CHARS = 600_000

SYSTEM = """You summarise transcripts and notes for a study group.

Produce, in this order and only if the source supports them:
- **Summary** — a short paragraph on what was covered.
- **Key points** — the substantive claims, as bullets.
- **Decisions** — anything the group settled on.
- **Action items** — who agreed to do what, by when if stated.
- **Open questions** — anything raised and left unresolved.

Rules: use only what is in the source; never invent a name, date or number. If a
section has nothing in it, omit the heading entirely. Write plain Markdown with no
preamble."""

REDUCE_SYSTEM = """You merge several partial summaries of one recording into a single
summary, using the same headings. Remove duplication, keep every distinct point,
preserve the original ordering of the material, and invent nothing."""


def _chunks(text: str) -> list[str]:
    if len(text) <= CHUNK_CHARS:
        return [text]
    out: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + CHUNK_CHARS)
        # Prefer a line break so a chunk does not split mid-sentence.
        if end < len(text):
            newline = text.rfind("\n", start + CHUNK_CHARS // 2, end)
            if newline != -1:
                end = newline
        out.append(text[start:end])
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return out


def summarise_text(text: str, progress: ProgressFn, *, base: float = 0.0, span: float = 1.0) -> tuple[str, dict[str, Any]]:
    """Map-reduce a transcript into one summary. Shared with the audio pipeline."""
    parts = _chunks(text)
    tokens_in = 0
    tokens_out = 0

    def track(result: llm.LLMResult) -> str:
        nonlocal tokens_in, tokens_out
        tokens_in += result.input_tokens or 0
        tokens_out += result.output_tokens or 0
        return result.text

    if len(parts) == 1:
        progress(base + span * 0.5, "summarising")
        summary = track(llm.complete(SYSTEM, parts[0]))
    else:
        drafts: list[str] = []
        for index, part in enumerate(parts, 1):
            progress(
                base + span * 0.8 * (index - 1) / len(parts),
                f"summarising part {index}/{len(parts)}",
            )
            drafts.append(track(llm.complete(SYSTEM, part)))
        progress(base + span * 0.85, f"merging {len(parts)} partial summaries")
        joined = "\n\n---\n\n".join(f"Part {i}:\n{d}" for i, d in enumerate(drafts, 1))
        summary = track(llm.complete(REDUCE_SYSTEM, joined))

    return summary, {
        "provider": llm.provider(),
        "model": llm.model_name(),
        "chunks": len(parts),
        "inputTokens": tokens_in or None,
        "outputTokens": tokens_out or None,
    }


@register
class Summarise(BaseEnhancer):
    name = "summarise"
    label = "Summarise"
    description = (
        "Turns notes or a transcript into a summary with key points, decisions, action items "
        "and open questions. Long input is summarised in parts and then merged, so a full "
        "lecture transcript does not have to fit in one request. Needs a language model "
        "configured."
    )
    media_type = "text"

    @classmethod
    def available(cls) -> bool:
        return llm.available()

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        started = time.monotonic()
        source = input_path.read_text(encoding="utf-8", errors="replace").strip()
        if not source:
            raise ValueError("nothing to summarise: the input is empty")
        if len(source) > MAX_INPUT_CHARS:
            raise ValueError(
                f"input is {len(source)} chars, over the {MAX_INPUT_CHARS} limit"
            )

        progress(0.05, f"summarising with {llm.describe()}")
        summary, meta = summarise_text(source, progress, base=0.05, span=0.9)

        target = output_path.with_name("summary.md")
        target.write_text(summary + "\n", encoding="utf-8")

        elapsed = time.monotonic() - started
        meta["charsIn"] = len(source)
        return EnhanceResult(
            artifacts=[
                ProducedArtifact(
                    path=target,
                    kind="summary",
                    label="Summary",
                    mime_type="text/markdown",
                    meta=meta,
                )
            ],
            message=f"summarised {len(source)} chars with {llm.describe()} in {elapsed:.0f}s",
            metrics={"seconds": round(elapsed, 2), **meta},
        )
