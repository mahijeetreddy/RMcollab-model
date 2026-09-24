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

MAX_INPUT_CHARS = 200_000

SYSTEM_PROMPT = """You rewrite text to be clearer and more readable.

Rules:
- Preserve the author's meaning, voice, and level of formality. Do not editorialise.
- Fix grammar, spelling, punctuation, and awkward phrasing.
- Tighten wordy sentences, but never drop information.
- Keep the original structure: paragraphs stay paragraphs, lists stay lists.
- Return only the rewritten text. No preamble, no commentary, no code fences."""


def _max_tokens_for(text: str) -> int:
    # A rewrite lands near the input's length; leave headroom without allowing a
    # runaway generation on a short input.
    estimated = int(len(text) / 3 * 1.6)
    return max(1024, min(64_000, estimated))


@register
class LLMRewrite(BaseEnhancer):
    name = "rewrite"
    label = "LLM rewrite"
    description = (
        "Rewrites for clarity, grammar and flow with a language model while preserving the "
        "author's meaning and voice. Uses whichever provider is configured — the Claude API, "
        "or any OpenAI-compatible endpoint."
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
            raise ValueError("input text is empty")
        if len(source) > MAX_INPUT_CHARS:
            raise ValueError(f"input is {len(source)} chars, limit is {MAX_INPUT_CHARS}")

        progress(0.1, f"rewriting with {llm.describe()}")
        result = llm.complete(SYSTEM_PROMPT, source, max_tokens=_max_tokens_for(source))
        progress(0.9, "writing result")

        output_path.write_text(result.text + "\n", encoding="utf-8")
        elapsed = time.monotonic() - started
        return EnhanceResult(
            artifacts=[
                ProducedArtifact(
                    path=output_path,
                    kind="enhanced",
                    label="Rewritten",
                    mime_type="text/plain",
                    meta={
                        "provider": result.provider,
                        "model": result.model,
                        "inputTokens": result.input_tokens,
                        "outputTokens": result.output_tokens,
                    },
                )
            ],
            message=f"rewritten by {result.provider}/{result.model}",
            metrics={
                "seconds": round(elapsed, 2),
                "provider": result.provider,
                "model": result.model,
                "charsIn": len(source),
                "charsOut": len(result.text),
            },
        )
