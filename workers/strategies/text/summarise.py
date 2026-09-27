from __future__ import annotations

import re
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
#
# Every merge is a chance to lose a detail - measured, a three-part merge dropped
# a named action item - so a provider with a large context should raise this via
# LLM_CHUNK_CHARS and summarise a whole lecture in one request.
CHUNK_CHARS = 24_000
CHUNK_OVERLAP = 800
MAX_INPUT_CHARS = 600_000
MIN_CHUNK_CHARS = 4_000


def chunk_chars() -> int:
    raw = llm.setting("CHUNK_CHARS", llm.SUMMARY)
    try:
        return max(MIN_CHUNK_CHARS, int(raw)) if raw else CHUNK_CHARS
    except ValueError:
        return CHUNK_CHARS


SYSTEM = """You summarise transcripts and notes for a study group.

Produce, in this order and only if the source supports them:
- **Summary** — a short paragraph on what was covered.
- **Key points** — the substantive claims, as bullets.
- **Decisions** — anything the group settled on.
- **Action items** — who agreed to do what, by when if stated.
- **Open questions** — anything raised and left unresolved.

Rules:
- Use only what is in the source; never invent a name, date or number, and never
  add explanation the speakers did not give.
- Concrete specifics come first: every date, deadline, number, place, and every
  task with its owner must survive. Prefer them over restating general concepts.
- Keep Key points to at most eight bullets; merge related ideas rather than
  listing every remark.
- Attribute a statement to a person only if the source shows they said it. A
  figure someone retracts or admits guessing is not a fact; leave it out.
- If a section has nothing in it, omit the heading entirely. Write plain Markdown
  with no preamble."""

REDUCE_SYSTEM = """You merge several partial summaries of one recording into a single
summary, using the same headings.

Every decision, action item (with its owner and deadline), date, number and open
question that appears in ANY part must appear in the merged summary - these are
the reason the summary exists. Remove duplication, shorten general discussion to
at most eight Key points, preserve the original order, and invent nothing."""


# Long recordings get a table of contents. The transcript's own [HH:MM:SS]
# stamps are what make this possible without a second pass over the audio.
#
# The model finds chapters within each part; code assembles them. Measured on a
# 54-minute transcript, leaving the merge to the model put 10 of 12 chapters in
# the first 5 minutes - it kept the earliest when trimming - and moved the
# section below the summary. Sorting, spreading and placing are exact jobs.
CHAPTERS_RULE = """
The source is part of a timestamped transcript. Also add a "## Chapters" section
FIRST: at most four lines, one per change of topic in this part, in order, each
exactly "- [HH:MM:SS] Topic" where the topic is three to eight plain words (no
bold, no punctuation at the end) and the timestamp is one that appears in the
source where the topic begins. Never write a timestamp that is not in the source."""

MAX_CHAPTERS = 12
_CHAPTER_LINE = re.compile(r"^\s*[-*]\s*\[(\d{1,2}:\d{2}:\d{2})\]\s*(.+?)\s*$")
_CHAPTERS_SECTION = re.compile(r"^#{1,6}\s*chapters\s*$", re.IGNORECASE)


def _seconds(stamp: str) -> int:
    h, m, sec = (int(x) for x in stamp.split(":"))
    return h * 3600 + m * 60 + sec


def _plain(topic: str) -> str:
    """A topic as the prompt asked for it: plain, short, no trailing mark."""
    topic = re.sub(r"[*_`]+", "", topic).strip(" -:;.")
    words = topic.split()
    return " ".join(words[:10]) + ("…" if len(words) > 10 else "")


def extract_chapters(markdown: str) -> tuple[list[tuple[str, str]], str]:
    """Pulls a "## Chapters" section out of a summary: its entries, and the rest."""
    lines = markdown.splitlines()
    chapters: list[tuple[str, str]] = []
    kept: list[str] = []
    inside = False
    for line in lines:
        if _CHAPTERS_SECTION.match(line.strip()):
            inside = True
            continue
        if inside and line.lstrip().startswith("#"):
            inside = False
        if inside:
            match = _CHAPTER_LINE.match(line)
            if match:
                chapters.append((match.group(1).zfill(8), _plain(match.group(2))))
            continue
        kept.append(line)
    return chapters, "\n".join(kept).strip()


def select_chapters(chapters: list[tuple[str, str]], limit: int = MAX_CHAPTERS) -> list[tuple[str, str]]:
    """In time order, repeated neighbours folded, at most `limit` - chosen evenly
    across the whole recording rather than the earliest `limit`."""
    ordered: list[tuple[str, str]] = []
    for stamp, topic in sorted(set(chapters), key=lambda c: _seconds(c[0])):
        if ordered and (ordered[-1][1].lower() == topic.lower() or ordered[-1][0] == stamp):
            continue
        ordered.append((stamp, topic))
    if len(ordered) <= limit:
        return ordered
    step = (len(ordered) - 1) / (limit - 1)
    return [ordered[round(i * step)] for i in range(limit)]


def with_chapters(summary: str, chapters: list[tuple[str, str]]) -> str:
    if not chapters:
        return summary
    block = "\n".join(f"- [{stamp}] {topic}" for stamp, topic in chapters)
    return f"## Chapters\n{block}\n\n{summary}"

def _chunks(text: str) -> list[str]:
    size = chunk_chars()
    if len(text) <= size:
        return [text]
    out: list[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + size)
        # Prefer a line break so a chunk does not split mid-sentence.
        if end < len(text):
            newline = text.rfind("\n", start + size // 2, end)
            if newline != -1:
                end = newline
        out.append(text[start:end])
        if end >= len(text):
            break
        start = max(end - CHUNK_OVERLAP, start + 1)
    return out


def summarise_text(
    text: str,
    progress: ProgressFn,
    *,
    base: float = 0.0,
    span: float = 1.0,
    chapters: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Map-reduce a transcript into one summary. Shared with the audio pipeline.

    `chapters` asks for a timestamped table of contents first; only meaningful
    for a transcript whose lines carry [HH:MM:SS] stamps.
    """
    parts = _chunks(text)
    system = SYSTEM + (CHAPTERS_RULE if chapters else "")
    found: list[tuple[str, str]] = []

    def split(draft: str) -> str:
        # Chapters come out of each draft before anything else sees it, so the
        # merge only merges prose and cannot reorder or drop them.
        if not chapters:
            return draft
        entries, rest = extract_chapters(draft)
        found.extend(entries)
        return rest
    tokens_in = 0
    tokens_out = 0

    def track(result: llm.LLMResult) -> str:
        nonlocal tokens_in, tokens_out
        tokens_in += result.input_tokens or 0
        tokens_out += result.output_tokens or 0
        return result.text

    if len(parts) == 1:
        progress(base + span * 0.5, "summarising")
        summary = split(track(llm.complete(system, parts[0], task=llm.SUMMARY)))
    else:
        drafts: list[str] = []
        for index, part in enumerate(parts, 1):
            progress(
                base + span * 0.8 * (index - 1) / len(parts),
                f"summarising part {index}/{len(parts)}",
            )
            drafts.append(split(track(llm.complete(system, part, task=llm.SUMMARY))))
        progress(base + span * 0.85, f"merging {len(parts)} partial summaries")
        joined = "\n\n---\n\n".join(f"Part {i}:\n{d}" for i, d in enumerate(drafts, 1))
        summary = track(llm.complete(REDUCE_SYSTEM, joined, task=llm.SUMMARY))

    if chapters:
        summary = with_chapters(summary, select_chapters(found))

    return summary, {
        "provider": llm.provider(llm.SUMMARY),
        "model": llm.model_name(llm.SUMMARY),
        "chunks": len(parts),
        "chapters": chapters,
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
        return llm.available(llm.SUMMARY)

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

        progress(0.05, f"summarising with {llm.describe(llm.SUMMARY)}")
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
            message=f"summarised {len(source)} chars with {llm.describe(llm.SUMMARY)} in {elapsed:.0f}s",
            metrics={"seconds": round(elapsed, 2), **meta},
        )
