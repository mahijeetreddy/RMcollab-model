"""Daily budgets for model calls, shared by every worker through Redis.

Free tiers cap requests per day - Gemini's image model at 20 - and a public
room can spend that in minutes. Each task profile (image reading, summaries,
rewrites, answers) gets its own daily allowance of calls, counted cluster-wide.
When one runs out the strategies that need it report themselves unavailable
with a plain reason, so the app offers something that can run ("image reading
is paused until tomorrow") instead of starting a job that will fail.

Counted in calls, not tokens, because that is what the free tiers limit. A day
is a UTC day, which is when the providers' own quotas reset.

    LLM_<TASK>_DAILY_BUDGET=<n>   0 means no limit
"""

from __future__ import annotations

import datetime as dt
import logging
import os

log = logging.getLogger(__name__)

# Sized to the free tiers in use: Gemini's 20 image requests a day with a little
# headroom, and Groq's allowance for the text tasks. `None` is the shared
# profile, used when a strategy names no task.
DEFAULT_BUDGETS: dict[str | None, int] = {
    "vision": 18,
    "summary": 300,
    "rewrite": 800,
    "ask": 800,
    None: 500,
}

# What each task is called when telling a person it is paused.
DESCRIPTIONS: dict[str | None, str] = {
    "vision": "Image reading",
    "summary": "Summaries",
    "rewrite": "Rewriting",
    "ask": "Answering questions",
    None: "The language model",
}

KEY_TTL_S = 2 * 24 * 3600


class BudgetExhausted(RuntimeError):
    """Today's allowance for this task is spent."""

    def __init__(self, task: str | None) -> None:
        self.task = task
        super().__init__(paused_reason(task))


def _today() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")


def _key(task: str | None) -> str:
    return f"rmcollab:llm-budget:{task or 'default'}:{_today()}"


def limit(task: str | None) -> int | None:
    """Today's allowance, or None for no limit."""
    raw = (os.getenv(f"LLM_{(task or 'DEFAULT').upper()}_DAILY_BUDGET") or "").strip()
    if raw:
        try:
            value = int(raw)
        except ValueError:
            log.warning("ignoring non-integer LLM_%s_DAILY_BUDGET=%r", (task or "DEFAULT").upper(), raw)
        else:
            return None if value <= 0 else value
    return DEFAULT_BUDGETS.get(task, DEFAULT_BUDGETS[None])


def paused_reason(task: str | None) -> str:
    return f"{DESCRIPTIONS.get(task, 'The language model')} is paused until tomorrow: today's limit is used up"


def _redis():
    # Imported here so budgets work in any process that has events configured,
    # and the module imports cleanly in tests that never touch Redis.
    from workers.common.events import get_redis

    return get_redis()


def used(task: str | None) -> int:
    try:
        value = _redis().get(_key(task))
    except Exception:  # noqa: BLE001 - a Redis hiccup must not stop work
        return 0
    return int(value or 0)


def exhausted(task: str | None) -> bool:
    cap = limit(task)
    return cap is not None and used(task) >= cap


def spend(task: str | None) -> None:
    """Counts one call against today's budget, refusing it if none is left."""
    cap = limit(task)
    if cap is None:
        return
    try:
        client = _redis()
        key = _key(task)
        count = client.incr(key)
        if count == 1:
            client.expire(key, KEY_TTL_S)
    except Exception as exc:  # noqa: BLE001 - fail open: Redis down is not "out of budget"
        log.warning("could not count a %s call against its budget: %s", task or "default", exc)
        return
    if count > cap:
        raise BudgetExhausted(task)


def mark_exhausted(task: str | None) -> None:
    """The provider says its own daily quota is gone: treat today's budget as spent."""
    cap = limit(task)
    if cap is None:
        return
    try:
        client = _redis()
        client.set(_key(task), cap, ex=KEY_TTL_S)
        log.warning("%s: provider reports its daily quota spent; paused until tomorrow", task or "default")
    except Exception:  # noqa: BLE001
        pass
