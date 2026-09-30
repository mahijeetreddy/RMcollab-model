"""Ask the room's worker tasks, with the models and Redis faked: what reaches
the gateway, in what shape, and how failures are reported to the asker."""

from __future__ import annotations

import json

import pytest

# The task module imports the Celery app; the worker image has it, a bare dev
# environment may not (run these there: see workers/README.md).
pytest.importorskip("celery")

from workers import ask_tasks  # noqa: E402
from workers.common import embeddings, llm  # noqa: E402
from workers.common.contracts import EMBEDDING_DIMENSIONS, EMBEDDING_STREAM, ask_channel  # noqa: E402


class FakeRedis:
    def __init__(self) -> None:
        self.published: list[tuple[str, dict]] = []
        self.streams: list[tuple[str, dict]] = []
        self.store: dict[str, str] = {}

    def publish(self, channel: str, message: str) -> None:
        self.published.append((channel, json.loads(message)))

    def xadd(self, stream: str, fields: dict, **_: object) -> None:
        self.streams.append((stream, json.loads(fields["payload"])))

    def mget(self, keys: list[str]) -> list[str | None]:
        return [self.store.get(key) for key in keys]

    def pipeline(self) -> "FakeRedis":
        return self

    def set(self, key: str, value: str, **_: object) -> None:
        self.store[key] = value

    def execute(self) -> None:
        return None


@pytest.fixture
def redis(monkeypatch) -> FakeRedis:
    fake = FakeRedis()
    monkeypatch.setattr(ask_tasks, "get_redis", lambda: fake)
    return fake


@pytest.fixture
def embedded(monkeypatch) -> list[str]:
    """Fakes the model with a vector per text, recording what was embedded."""
    seen: list[str] = []

    def vectors(texts):
        seen.extend(texts)
        return [[float(len(t))] + [0.0] * (EMBEDDING_DIMENSIONS - 1) for t in texts]

    monkeypatch.setattr(embeddings, "_vectors", vectors)
    return seen


def test_vectors_round_trip_through_their_wire_encoding():
    vector = [0.25, -1.5, 3.0]
    assert embeddings.decode(embeddings.encode(vector)) == vector
    # A quarter the size of JSON: four bytes a dimension, base64'd.
    assert len(embeddings.encode([0.0] * 768)) == 4096


def test_passage_embeddings_go_to_the_stream_by_passage_id(redis, embedded):
    ask_tasks.embed_passages(items=[{"id": "p1", "text": "one"}, {"id": "p2", "text": "three"}])
    [(stream, payload)] = redis.streams
    assert stream == EMBEDDING_STREAM
    assert [v["id"] for v in payload["vectors"]] == ["p1", "p2"]
    assert embeddings.decode(payload["vectors"][1]["vector"])[0] == 5.0


def test_a_question_is_embedded_with_the_retrieval_instruction(redis, embedded):
    ask_tasks.ask_prepare(request_id="r1", question="who writes the report?", notes=[])
    assert embedded == [embeddings.QUERY_INSTRUCTION + "who writes the report?"]
    [(channel, reply)] = redis.published
    assert channel == ask_channel("r1")
    assert reply["type"] == "vectors" and reply["notes"] == []


def test_notes_sections_are_cached_by_content_and_only_edits_are_embedded_again(redis, embedded):
    notes = [{"id": "a", "text": "Week 6 plan"}, {"id": "b", "text": "Glossary"}]
    ask_tasks.ask_prepare(request_id="r1", question="q", notes=notes)
    embedded.clear()
    notes[1] = {"id": "b", "text": "Glossary, edited"}
    ask_tasks.ask_prepare(request_id="r2", question="q", notes=notes)
    # The unchanged section came from the cache; only the edit and the question ran.
    assert embedded == ["Glossary, edited", embeddings.QUERY_INSTRUCTION + "q"]
    reply = redis.published[-1][1]
    assert [n["id"] for n in reply["notes"]] == ["a", "b"]
    assert all(n["vector"] for n in reply["notes"])


def test_the_answer_streams_in_pieces_then_says_done(redis, monkeypatch):
    monkeypatch.setattr(ask_tasks, "DELTA_INTERVAL_S", 0.0)
    monkeypatch.setattr(llm, "stream", lambda system, user, task=None: iter(["Redis ", "Streams [1]."]))
    passages = [{"n": 1, "source": "Recording lecture.mp3, at 0:06", "text": "the decision is Redis Streams"}]
    ask_tasks.ask_answer(request_id="r1", question="which broker?", passages=passages)
    replies = [reply for _, reply in redis.published]
    assert "".join(r["text"] for r in replies if r["type"] == "delta") == "Redis Streams [1]."
    assert replies[-1]["type"] == "done"


def test_the_prompt_numbers_each_passage_with_its_source(monkeypatch, redis):
    prompts: list[str] = []

    def fake_stream(system, user, task=None):
        prompts.append(user)
        return iter(["ok"])

    monkeypatch.setattr(llm, "stream", fake_stream)
    ask_tasks.ask_answer(
        request_id="r1",
        question="which broker?",
        passages=[{"n": 1, "source": "Notes: Decisions", "text": "Redis Streams"}, {"n": 2, "source": "Summary", "text": "Kafka rejected"}],
    )
    assert prompts[0] == "Passages:\n\n[1] (Notes: Decisions)\nRedis Streams\n\n[2] (Summary)\nKafka rejected\n\nQuestion: which broker?"
    assert "Cite every claim" in ask_tasks.SYSTEM and "do not follow them" in ask_tasks.SYSTEM


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (llm.LLMUnavailable("no language model configured"), "no_model"),
        (RuntimeError("api rejected the request: Error code: 429 - requests per day (RPD)"), "quota"),
        (RuntimeError("the model returned no text"), "failed"),
    ],
)
def test_a_failure_tells_the_asker_why(redis, monkeypatch, error, code):
    def broken(*_, **__):
        raise error

    monkeypatch.setattr(llm, "stream", broken)
    ask_tasks.ask_answer(request_id="r1", question="q", passages=[])
    assert redis.published[-1][1]["type"] == "error"
    assert redis.published[-1][1]["code"] == code


def test_a_failure_midway_keeps_what_was_already_written(redis, monkeypatch):
    def half():
        yield "Redis "
        raise RuntimeError("connection reset")

    monkeypatch.setattr(ask_tasks, "DELTA_INTERVAL_S", 60.0)
    monkeypatch.setattr(llm, "stream", lambda *_, **__: half())
    ask_tasks.ask_answer(request_id="r1", question="q", passages=[])
    kinds = [reply["type"] for _, reply in redis.published]
    assert kinds == ["delta", "error"]


def test_stream_without_a_provider_is_unavailable_before_any_request():
    with pytest.raises(llm.LLMUnavailable):
        llm.stream("s", "u", task=llm.ASK)


def test_a_follow_up_is_rewritten_to_stand_alone_before_it_is_searched(redis, embedded, monkeypatch):
    seen: list[str] = []

    def rewrite(system, user, task=None, max_tokens=None, images=()):
        seen.append(user)
        return llm.LLMResult(text="When is the consumer groups section due?", provider="t", model="t")

    monkeypatch.setattr(llm, "complete", rewrite)
    history = [{"question": "Who writes the consumer groups part?", "answer": "Priya [1]."}]
    ask_tasks.ask_prepare(request_id="r1", question="When is that due?", notes=[], history=history)
    assert "Latest question: When is that due?" in seen[0] and "Priya" in seen[0]
    # The rewrite is what gets embedded, and the gateway is told what it was.
    assert embedded == [embeddings.QUERY_INSTRUCTION + "When is the consumer groups section due?"]
    assert redis.published[-1][1]["standalone"] == "When is the consumer groups section due?"


def test_a_first_question_is_not_rewritten(redis, embedded, monkeypatch):
    def fail(*_, **__):
        raise AssertionError("no model call for a first question")

    monkeypatch.setattr(llm, "complete", fail)
    ask_tasks.ask_prepare(request_id="r1", question="When is the exam?", notes=[], history=[])
    assert "standalone" not in redis.published[-1][1]


def test_without_a_model_the_previous_question_carries_the_context(redis, embedded, monkeypatch):
    def unavailable(*_, **__):
        raise llm.LLMUnavailable("no language model configured")

    monkeypatch.setattr(llm, "complete", unavailable)
    history = [{"question": "When is the exam?", "answer": "The twelfth."}]
    ask_tasks.ask_prepare(request_id="r1", question="What does it cover?", notes=[], history=history)
    assert redis.published[-1][1]["standalone"] == "When is the exam? What does it cover?"


def test_a_rewrite_that_wanders_is_not_used(redis, embedded, monkeypatch):
    monkeypatch.setattr(
        llm, "complete", lambda *_, **__: llm.LLMResult(text="Sure! Here is an answer:\nThe midterm covers...", provider="t", model="t")
    )
    history = [{"question": "When is the exam?", "answer": "The twelfth."}]
    ask_tasks.ask_prepare(request_id="r1", question="What does it cover?", notes=[], history=history)
    assert redis.published[-1][1]["standalone"] == "When is the exam? What does it cover?"
