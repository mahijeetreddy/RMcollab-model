from __future__ import annotations

from pathlib import Path

import pytest

from workers.common import llm
from workers.strategies.text import summarise as summ
from workers.strategies.text.rulebased import RuleBasedText


def noop(fraction: float, message: str | None = None) -> None:
    pass


class TestRuleBased:
    @pytest.fixture
    def clean(self, tmp_path: Path):
        def run(text: str) -> str:
            src = tmp_path / "in.txt"
            src.write_text(text, encoding="utf-8")
            out = tmp_path / "out.txt"
            RuleBasedText().enhance(src, out, {}, noop)
            return out.read_text(encoding="utf-8").strip()

        return run

    def test_fixes_common_typos_and_contractions(self, clean):
        assert clean("teh dog dont bark alot") == "The dog don't bark a lot."

    def test_preserves_capitalisation_of_a_corrected_word(self, clean):
        assert clean("Teh start").startswith("The start")

    def test_collapses_runs_of_spaces(self, clean):
        assert "  " not in clean("one  two   three")

    def test_fixes_space_before_punctuation(self, clean):
        assert clean("hello , world .") == "Hello, world."

    def test_capitalises_each_sentence(self, clean):
        assert clean("first thing. second thing") == "First thing. Second thing."

    def test_adds_terminal_punctuation_only_when_missing(self, clean):
        assert clean("already done!") == "Already done!"
        assert clean("needs a stop") == "Needs a stop."


class TestChunking:
    def test_short_text_is_one_chunk(self):
        assert summ._chunks("short") == ["short"]

    def test_long_text_splits_within_the_limit(self):
        text = "".join(f"line {i} with some words in it\n" for i in range(5000))
        chunks = summ._chunks(text)
        assert len(chunks) > 1
        assert all(len(c) <= summ.CHUNK_CHARS for c in chunks)

    def test_chunks_cover_the_whole_input(self):
        text = "".join(f"segment number {i}\n" for i in range(6000))
        chunks = summ._chunks(text)
        assert chunks[0].startswith("segment number 0\n")
        assert chunks[-1].endswith("segment number 5999\n")

    def test_chunks_prefer_to_break_on_a_line(self):
        # A chunk that splits mid-sentence gives the model half a thought.
        text = "".join(f"a full sentence number {i}.\n" for i in range(3000))
        for chunk in summ._chunks(text)[:-1]:
            assert chunk.endswith(".")

    def test_chunk_size_follows_the_environment(self, monkeypatch):
        # A large-context provider summarises a whole lecture in one request,
        # which avoids the merge step where details were measured to go missing.
        text = "x" * 100_000
        assert len(summ._chunks(text)) > 1
        monkeypatch.setenv("LLM_CHUNK_CHARS", "200000")
        assert summ._chunks(text) == [text]

    @pytest.mark.parametrize(("raw", "expected"), [("10", summ.MIN_CHUNK_CHARS), ("junk", summ.CHUNK_CHARS)])
    def test_chunk_size_rejects_nonsense(self, monkeypatch, raw, expected):
        monkeypatch.setenv("LLM_CHUNK_CHARS", raw)
        assert summ.chunk_chars() == expected

    def test_consecutive_chunks_overlap(self):
        text = "".join(f"unique-{i:05d}\n" for i in range(8000))
        first, second = summ._chunks(text)[:2]
        assert first[-summ.CHUNK_OVERLAP // 2 :] in second


class TestMapReduce:
    @pytest.fixture
    def calls(self, monkeypatch):
        log: list[tuple[str, int]] = []

        def stub(system: str, user: str, *, max_tokens: int | None = None, task: str | None = None) -> llm.LLMResult:
            # Every call must be routed as a summary, so LLM_SUMMARY_* applies.
            assert task == llm.SUMMARY
            log.append(("reduce" if system.startswith(summ.REDUCE_SYSTEM) else "map", len(user)))
            return llm.LLMResult(
                text=f"- summary of {len(user)} chars",
                provider="stub",
                model="stub-1",
                input_tokens=len(user) // 4,
                output_tokens=10,
            )

        monkeypatch.setattr(summ.llm, "complete", stub)
        return log

    def test_short_input_is_a_single_call_with_no_reduce(self, calls):
        summ.summarise_text("A short transcript.", noop)
        assert [kind for kind, _ in calls] == ["map"]

    def test_long_input_maps_each_chunk_then_reduces_once(self, calls):
        text = "".join(f"[00:00:{i % 60:02d}] point {i} discussed at length here.\n" for i in range(4000))
        _, meta = summ.summarise_text(text, noop)
        kinds = [kind for kind, _ in calls]
        assert kinds.count("reduce") == 1
        assert kinds.count("map") == meta["chunks"] > 1
        assert kinds[-1] == "reduce"

    def test_every_map_call_fits_the_chunk_limit(self, calls):
        text = "x" * (summ.CHUNK_CHARS * 3 + 17)
        summ.summarise_text(text, noop)
        assert all(n <= summ.CHUNK_CHARS for kind, n in calls if kind == "map")

    def test_token_usage_is_summed_across_every_call(self, calls):
        text = "word " * 20_000
        _, meta = summ.summarise_text(text, noop)
        assert meta["outputTokens"] == 10 * len(calls)

    def test_progress_moves_forward(self, calls):
        seen: list[float] = []
        text = "".join(f"line {i}\n" for i in range(20_000))
        summ.summarise_text(text, lambda f, m=None: seen.append(f))
        assert seen == sorted(seen)


class TestChapters:
    @pytest.fixture
    def prompts(self, monkeypatch):
        seen: list[str] = []

        def stub(system, user, *, max_tokens=None, task=None):
            seen.append(system)
            return llm.LLMResult(text="- point", provider="stub", model="stub-1")

        monkeypatch.setattr(summ.llm, "complete", stub)
        return seen

    def test_off_by_default(self, prompts):
        summ.summarise_text("[00:00:00] short", lambda *a: None)
        assert all(summ.CHAPTERS_RULE not in p for p in prompts)

    def test_asked_for_in_every_part_and_kept_through_the_merge(self, prompts, monkeypatch):
        monkeypatch.setenv("LLM_CHUNK_CHARS", "4000")
        summ.summarise_text("[00:00:01] line of the lecture\n" * 400, lambda *a: None, chapters=True)
        maps, reduce = prompts[:-1], prompts[-1]
        assert len(maps) > 1
        assert all(summ.CHAPTERS_RULE in p for p in maps)
        # Chapters are assembled in code, so the merge never sees them.
        assert summ.CHAPTERS_RULE not in reduce

    def test_the_rule_forbids_invented_timestamps(self):
        assert "never write a timestamp that is not in the source" in summ.CHAPTERS_RULE.lower()


class TestChapterAssembly:
    def test_extract_pulls_the_section_out_and_leaves_the_rest(self):
        chapters, rest = summ.extract_chapters(
            "## Chapters\n- [00:00:05] **Intro** to queues.\n- [0:04:10] Consumer groups\n\n## Summary\nText."
        )
        assert chapters == [("00:00:05", "Intro to queues"), ("00:04:10", "Consumer groups")]
        assert rest == "## Summary\nText."

    def test_select_spreads_across_the_whole_recording(self):
        # The measured failure: 10 of 12 chapters in the first five minutes.
        many = [(f"00:{m:02d}:00", f"Topic {m}") for m in range(0, 54)]
        picked = summ.select_chapters(many, limit=12)
        assert len(picked) == 12
        assert picked[0][0] == "00:00:00" and picked[-1][0] == "00:53:00"
        minutes = [int(stamp[3:5]) for stamp, _ in picked]
        assert max(b - a for a, b in zip(minutes, minutes[1:])) <= 6

    def test_select_orders_and_folds_repeats(self):
        picked = summ.select_chapters(
            [("00:10:00", "B"), ("00:00:00", "A"), ("00:12:00", "b"), ("00:10:00", "B")]
        )
        assert picked == [("00:00:00", "A"), ("00:10:00", "B")]

    def test_the_chapters_block_leads_the_summary(self, monkeypatch):
        def stub(system, user, *, max_tokens=None, task=None):
            return llm.LLMResult(
                text="## Summary\nWords.\n\n## Chapters\n- [00:00:01] Opening", provider="s", model="m"
            )

        monkeypatch.setattr(summ.llm, "complete", stub)
        summary, _ = summ.summarise_text("[00:00:01] hi", lambda *a: None, chapters=True)
        assert summary.startswith("## Chapters\n- [00:00:01] Opening\n\n## Summary")
