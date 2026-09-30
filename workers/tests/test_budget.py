"""Daily model budgets: counted cluster-wide in Redis, and a spent one reads as
"paused until tomorrow" everywhere a person would see it."""

from __future__ import annotations

import pytest

from workers.common import budget, llm


class FakeRedis:
    def __init__(self) -> None:
        self.data: dict[str, int] = {}

    def incr(self, key: str) -> int:
        self.data[key] = self.data.get(key, 0) + 1
        return self.data[key]

    def expire(self, *_: object) -> None:
        return None

    def get(self, key: str):
        return self.data.get(key)

    def set(self, key: str, value: int, **_: object) -> None:
        self.data[key] = int(value)


@pytest.fixture
def redis(monkeypatch) -> FakeRedis:
    fake = FakeRedis()
    monkeypatch.setattr(budget, "_redis", lambda: fake)
    return fake


def test_calls_are_counted_until_the_day_is_spent(redis, monkeypatch):
    monkeypatch.setenv("LLM_VISION_DAILY_BUDGET", "2")
    budget.spend("vision")
    budget.spend("vision")
    assert budget.exhausted("vision")
    with pytest.raises(budget.BudgetExhausted, match="Image reading is paused until tomorrow"):
        budget.spend("vision")
    # Each task has its own allowance.
    assert not budget.exhausted("summary")


def test_zero_means_no_limit(redis, monkeypatch):
    monkeypatch.setenv("LLM_ASK_DAILY_BUDGET", "0")
    for _ in range(5):
        budget.spend("ask")
    assert budget.limit("ask") is None and not budget.exhausted("ask")


def test_the_free_image_tier_is_the_default_cap():
    assert budget.limit("vision") == 18


def test_a_providers_own_daily_quota_pauses_the_task(redis):
    class Quota(Exception):
        status_code = 429

    llm._note_daily_quota("vision", Quota("429 quota exceeded: GenerateRequestsPerDayPerProject"))
    assert budget.exhausted("vision")
    # A per-minute 429 is waited out, not treated as the day being over.
    llm._note_daily_quota("summary", Quota("429 rate limit: requests per minute"))
    assert not budget.exhausted("summary")


def test_a_spent_budget_makes_the_task_unavailable_with_a_reason(redis, monkeypatch):
    monkeypatch.setenv("LLM_BASE_URL", "https://example.test/v1")
    monkeypatch.setenv("LLM_API_KEY", "k")
    monkeypatch.setenv("LLM_MODEL", "m")
    monkeypatch.setenv("LLM_REWRITE_DAILY_BUDGET", "1")
    assert llm.available(llm.REWRITE) and llm.unavailable_reason(llm.REWRITE) == ""
    budget.spend("rewrite")
    assert not llm.available(llm.REWRITE)
    assert llm.unavailable_reason(llm.REWRITE) == "Rewriting is paused until tomorrow: today's limit is used up"
    with pytest.raises(llm.LLMUnavailable, match="paused until tomorrow"):
        llm.complete("s", "u", task=llm.REWRITE)


def test_redis_down_never_blocks_work(monkeypatch):
    def broken():
        raise ConnectionError("redis is down")

    monkeypatch.setattr(budget, "_redis", broken)
    budget.spend("vision")
    assert not budget.exhausted("vision")
