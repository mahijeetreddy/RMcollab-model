from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register

CONTRACTIONS = {
    "dont": "don't",
    "doesnt": "doesn't",
    "didnt": "didn't",
    "cant": "can't",
    "wont": "won't",
    "isnt": "isn't",
    "arent": "aren't",
    "wasnt": "wasn't",
    "werent": "weren't",
    "hasnt": "hasn't",
    "havent": "haven't",
    "shouldnt": "shouldn't",
    "wouldnt": "wouldn't",
    "couldnt": "couldn't",
    "im": "I'm",
    "ive": "I've",
    "ill": "I'll",
    "youre": "you're",
    "theyre": "they're",
    "thats": "that's",
    "its's": "it's",
}

TYPOS = {
    "teh": "the",
    "adn": "and",
    "recieve": "receive",
    "seperate": "separate",
    "occured": "occurred",
    "definately": "definitely",
    "alot": "a lot",
}

SENTENCE_START = re.compile(r"(^|(?<=[.!?])\s+)([a-z])")


def _fix_words(text: str) -> str:
    def swap(match: re.Match[str]) -> str:
        word = match.group(0)
        lowered = word.lower()
        replacement = TYPOS.get(lowered) or CONTRACTIONS.get(lowered)
        if replacement is None:
            return word
        return replacement.capitalize() if word[0].isupper() else replacement

    return re.sub(r"\b[\w']+\b", swap, text)


@register(default=True)
class RuleBasedText(BaseEnhancer):
    name = "rulebased"
    label = "Rule-based cleanup"
    description = (
        "Deterministic offline cleanup: whitespace, punctuation spacing, sentence "
        "capitalisation, common typos and contractions. No model, no API key, no network."
    )
    media_type = "text"

    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        text = input_path.read_text(encoding="utf-8", errors="replace")

        progress(0.2, "normalising whitespace")
        # Collapse runs of spaces/tabs but keep paragraph breaks intact.
        text = re.sub(r"[ \t]+", " ", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = "\n".join(line.strip() for line in text.split("\n"))

        progress(0.45, "fixing punctuation spacing")
        text = re.sub(r"\s+([,.!?;:])", r"\1", text)
        text = re.sub(r"([,;:])(?=\S)", r"\1 ", text)
        text = re.sub(r"([.!?])(?=[A-Za-z])", r"\1 ", text)

        progress(0.7, "correcting common typos")
        text = _fix_words(text)

        progress(0.9, "capitalising sentences")
        text = SENTENCE_START.sub(lambda m: m.group(1) + m.group(2).upper(), text)
        text = text.strip()
        if text and text[-1] not in ".!?":
            text += "."

        output_path.write_text(text + "\n", encoding="utf-8")
        return EnhanceResult(
            output_path=output_path,
            message="cleaned up with deterministic rules",
            metrics={"chars_in": len(text)},
        )
