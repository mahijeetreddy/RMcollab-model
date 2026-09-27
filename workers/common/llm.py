"""The one place a language-model provider is chosen.

Strategies call `complete()` and never import a vendor SDK themselves, so
switching between Anthropic and any OpenAI-compatible endpoint (OpenRouter,
Groq, Gemini, a local vLLM) is a config change rather than an edit spread across
every strategy that happens to use a model.

Selection, in order:
  LLM_PROVIDER=anthropic|openai      explicit wins
  ANTHROPIC_API_KEY set              -> anthropic
  LLM_API_KEY + LLM_BASE_URL set     -> openai-compatible
  otherwise                          -> unavailable, and strategies say so

Task profiles. Tasks want different things: a rewrite is short and someone is
waiting on it, so it should be fast; a summary is long and read carefully, so it
should be thorough. Any OpenAI-compatible setting can be overridden for one task
by inserting the task name - LLM_REWRITE_MODEL, LLM_SUMMARY_REASONING_EFFORT,
LLM_REWRITE_BASE_URL + LLM_REWRITE_API_KEY for a different provider entirely -
and falls back to the shared LLM_* value when it is not.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import random
import re
import threading
import time
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Callable, TypeVar

log = logging.getLogger(__name__)

ANTHROPIC = "anthropic"
OPENAI_COMPATIBLE = "openai"

REWRITE = "rewrite"
SUMMARY = "summary"
# Reading images. Its own profile because the text model is often not a vision
# model (Groq's gpt-oss is not), so images can go to a different provider.
VISION = "vision"

DEFAULT_ANTHROPIC_MODEL = "claude-opus-5"
# Reasoning models spend part of this budget thinking before they write the
# answer, so it is sized for that rather than for the summary alone.
DEFAULT_MAX_TOKENS = 4096

# Free tiers answer "slow down" (429) and "overloaded" (503) routinely; measured
# against Groq and Gemini, both happened within minutes. These are waited out,
# not surfaced as a failed summary. Everything else fails immediately.
RETRYABLE_STATUS = frozenset({408, 409, 429, 500, 502, 503, 504})
RETRYABLE_ERRORS = frozenset({"APIConnectionError", "APITimeoutError"})
DEFAULT_RETRIES = 4
RETRY_BASE_S = 2.0
RETRY_CAP_S = 30.0
# A per-minute quota resets within a minute; a longer Retry-After means a daily
# cap, which waiting in a worker will not fix.
MAX_RETRY_AFTER_S = 65.0
# How providers name a per-day limit in a 429 body: Gemini's quota id
# ("...PerDayPerProject...") and Groq's "requests per day (RPD)".
DAILY_QUOTA = re.compile(r"per ?day|daily|\bRPD\b|\bTPD\b", re.IGNORECASE)

# httpx drops an idle pooled connection after 5s by default, so in a room where
# rewrites arrive a minute apart every call paid a fresh TCP + TLS handshake.
# Holding it longer keeps the connection warm between bursts; if the server has
# closed it meanwhile, the call reconnects (and a failure there is retried).
KEEPALIVE_S = 120.0
WARMUP_TIMEOUT_S = 10.0

T = TypeVar("T")


class LLMUnavailable(RuntimeError):
    """No provider is configured, or the configured one rejected us."""


@dataclass(frozen=True)
class Image:
    """An image sent inline with a prompt."""

    data: bytes
    mime_type: str

    def base64(self) -> str:
        import base64

        return base64.b64encode(self.data).decode("ascii")


@dataclass(frozen=True)
class LLMResult:
    text: str
    provider: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def setting(name: str, task: str | None = None) -> str:
    """LLM_<TASK>_<NAME> when set, else LLM_<NAME>."""
    if task:
        specific = _env(f"LLM_{task.upper()}_{name}")
        if specific:
            return specific
    return _env(f"LLM_{name}")


def _int_setting(name: str, default: int, task: str | None = None) -> int:
    raw = setting(name, task)
    try:
        return int(raw) if raw else default
    except ValueError:
        log.warning("ignoring non-integer LLM_%s=%r", name, raw)
        return default


def provider(task: str | None = None) -> str | None:
    explicit = setting("PROVIDER", task).lower()
    if explicit in (ANTHROPIC, OPENAI_COMPATIBLE):
        return explicit
    # A task with its own endpoint uses it even when Anthropic is the default:
    # that is the point of routing a latency-sensitive task elsewhere.
    if task and _env(f"LLM_{task.upper()}_BASE_URL") and _env(f"LLM_{task.upper()}_API_KEY"):
        return OPENAI_COMPATIBLE
    if _env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN"):
        return ANTHROPIC
    if setting("API_KEY", task) and setting("BASE_URL", task):
        return OPENAI_COMPATIBLE
    return None


def model_name(task: str | None = None) -> str:
    which = provider(task)
    if which == ANTHROPIC:
        return _env("CLAUDE_MODEL") or DEFAULT_ANTHROPIC_MODEL
    if which == OPENAI_COMPATIBLE:
        # No default: the operator names the model, because which free models an
        # OpenAI-compatible gateway offers changes over time.
        return setting("MODEL", task)
    return ""


def available(task: str | None = None) -> bool:
    which = provider(task)
    if which == ANTHROPIC:
        return importlib.util.find_spec("anthropic") is not None
    if which == OPENAI_COMPATIBLE:
        return bool(model_name(task)) and importlib.util.find_spec("openai") is not None
    return False


def vision_available() -> bool:
    """Whether images can be read, which needs more than any configured model.

    Every current Claude model reads images. An OpenAI-compatible endpoint only
    counts when a vision model is named for the task explicitly: the shared
    LLM_MODEL is usually a text model, and sending it an image fails the job
    rather than falling back.
    """
    which = provider(VISION)
    if which == ANTHROPIC:
        return available(VISION)
    if which == OPENAI_COMPATIBLE:
        return bool(_env("LLM_VISION_MODEL")) and available(VISION)
    return False


def describe(task: str | None = None) -> str:
    return f"{provider(task) or 'none'}/{model_name(task) or 'unconfigured'}"


def max_output_tokens(task: str | None = None) -> int:
    return _int_setting("MAX_TOKENS", DEFAULT_MAX_TOKENS, task)


def reasoning_effort(task: str | None = None) -> str | None:
    """Sent only when configured: not every OpenAI-compatible gateway accepts it."""
    return setting("REASONING_EFFORT", task).lower() or None


# --- clients -------------------------------------------------------------------
#
# One client per endpoint per process, built on first use. Celery forks its pool
# children from a parent that never calls a model, and reset_clients() runs in
# each child at start-up anyway, so a connection is never shared across a fork.


@lru_cache(maxsize=8)
def _openai_client(base_url: str, api_key: str) -> Any:
    import httpx
    from openai import DefaultHttpxClient, OpenAI

    # The SDK's own retries are off so there is one retry policy, ours, with the
    # same backoff and logging whichever gateway is behind the URL.
    return OpenAI(
        api_key=api_key,
        base_url=base_url,
        max_retries=0,
        http_client=DefaultHttpxClient(
            limits=httpx.Limits(max_connections=20, max_keepalive_connections=10, keepalive_expiry=KEEPALIVE_S)
        ),
    )


@lru_cache(maxsize=1)
def _anthropic_client() -> Any:
    import anthropic

    return anthropic.Anthropic()


def reset_clients() -> None:
    _openai_client.cache_clear()
    _anthropic_client.cache_clear()


def warm(tasks: tuple[str | None, ...] = (None, REWRITE, SUMMARY), *, block: bool = False) -> threading.Thread | None:
    """Import the SDK and open a connection before the first job needs it.

    A new pool process otherwise pays SDK import plus a TLS handshake on its first
    job - measured as the slowest rewrite a room sees. Runs in a background thread
    by default: Celery kills a pool child that takes more than a few seconds to
    report ready, and a slow or unreachable provider must not cause that.
    """
    endpoints = {
        (setting("BASE_URL", task), setting("API_KEY", task))
        for task in tasks
        if provider(task) == OPENAI_COMPATIBLE and available(task)
    }
    if not endpoints:
        return None

    def run() -> None:
        for base_url, api_key in endpoints:
            started = time.monotonic()
            try:
                # Listing models is free on every gateway tried, and completes the
                # TCP + TLS handshake that the first real call would otherwise pay.
                _openai_client(base_url, api_key).with_options(timeout=WARMUP_TIMEOUT_S).models.list()
                log.info("LLM connection to %s warm in %.2fs", base_url, time.monotonic() - started)
            except Exception as exc:  # noqa: BLE001 - warming is best effort
                log.info("LLM warm-up for %s skipped: %s", base_url, str(exc)[:120])

    if block:
        run()
        return None
    thread = threading.Thread(target=run, name="llm-warmup", daemon=True)
    thread.start()
    return thread


# --- retries -------------------------------------------------------------------


def _retry_after(exc: BaseException) -> float | None:
    response = getattr(exc, "response", None)
    headers = getattr(response, "headers", None) or {}
    try:
        value = float(headers.get("retry-after", ""))
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def retry_delay(exc: BaseException, attempt: int) -> float | None:
    """Seconds to wait before retrying `exc`, or None if it should not be retried.

    Exponential backoff with full jitter, so workers that were throttled together
    do not all come back in the same instant; a server's Retry-After wins when it
    asks for longer.
    """
    status = getattr(exc, "status_code", None)
    if status is None:
        if type(exc).__name__ not in RETRYABLE_ERRORS:
            return None
    elif status not in RETRYABLE_STATUS:
        return None

    # A spent daily quota is not worth waiting on, whatever delay the server
    # suggests: Gemini's free tier reports its 20-requests-a-day cap with a
    # "retry in 13s" hint that would just burn every retry.
    if status == 429 and DAILY_QUOTA.search(str(exc)):
        return None
    asked = _retry_after(exc)
    if asked is not None and asked > MAX_RETRY_AFTER_S:
        return None
    backoff = random.uniform(0, min(RETRY_CAP_S, RETRY_BASE_S * 2**attempt))
    return max(backoff, asked or 0.0)


def with_retries(call: Callable[[], T], *, sleep: Callable[[float], None] = time.sleep) -> T:
    attempts = max(0, _int_setting("MAX_RETRIES", DEFAULT_RETRIES))
    for attempt in range(attempts + 1):
        try:
            return call()
        except Exception as exc:  # noqa: BLE001 - classified by retry_delay
            delay = retry_delay(exc, attempt) if attempt < attempts else None
            if delay is None:
                raise
            log.warning(
                "LLM call failed (%s); retry %d/%d in %.1fs",
                getattr(exc, "status_code", type(exc).__name__),
                attempt + 1,
                attempts,
                delay,
            )
            sleep(delay)
    raise AssertionError("unreachable")  # pragma: no cover


# --- completion ----------------------------------------------------------------


def _complete_anthropic(system: str, user: str, max_tokens: int, images: tuple[Image, ...] = ()) -> LLMResult:
    import anthropic

    model = model_name()
    client = _anthropic_client()
    try:
        # Streamed so a long reduction cannot trip the SDK's request timeout.
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            output_config={"effort": _env("CLAUDE_EFFORT") or "low"},
            messages=[
                {
                    "role": "user",
                    "content": [
                        *(
                            {
                                "type": "image",
                                "source": {"type": "base64", "media_type": image.mime_type, "data": image.base64()},
                            }
                            for image in images
                        ),
                        {"type": "text", "text": user},
                    ]
                    if images
                    else user,
                }
            ],
        ) as stream:
            message = stream.get_final_message()
    except anthropic.AuthenticationError as exc:
        raise LLMUnavailable("Anthropic rejected the configured credentials") from exc
    except anthropic.RateLimitError as exc:
        raise RuntimeError("Anthropic rate limit reached; try again shortly") from exc
    except anthropic.APIStatusError as exc:
        raise RuntimeError(f"Anthropic error {exc.status_code}: {exc.message}") from exc
    except anthropic.APIConnectionError as exc:
        raise RuntimeError("could not reach the Anthropic API") from exc

    if message.stop_reason == "refusal":
        detail = getattr(message.stop_details, "explanation", None) or "no explanation given"
        raise RuntimeError(f"the model declined this request: {detail}")

    return LLMResult(
        text="".join(b.text for b in message.content if b.type == "text").strip(),
        provider=ANTHROPIC,
        model=model,
        input_tokens=message.usage.input_tokens,
        output_tokens=message.usage.output_tokens,
    )


def _complete_openai(
    system: str, user: str, max_tokens: int, task: str | None, images: tuple[Image, ...] = ()
) -> LLMResult:
    model = model_name(task)
    base_url = setting("BASE_URL", task)
    client = _openai_client(base_url, setting("API_KEY", task))
    extra: dict[str, Any] = {}
    effort = reasoning_effort(task)
    if effort:
        extra["reasoning_effort"] = effort
    content: Any = (
        [
            {"type": "text", "text": user},
            *(
                {"type": "image_url", "image_url": {"url": f"data:{image.mime_type};base64,{image.base64()}"}}
                for image in images
            ),
        ]
        if images
        else user
    )
    try:
        response = with_retries(
            lambda: client.chat.completions.create(
                model=model,
                max_tokens=max_tokens,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": content},
                ],
                **extra,
            )
        )
    except Exception as exc:  # noqa: BLE001 - surface any gateway's error as a job failure
        raise RuntimeError(f"{base_url} rejected the request: {exc}") from exc

    choice = response.choices[0] if response.choices else None
    text = ((choice.message.content if choice else None) or "").strip()
    if not text:
        if choice is not None and choice.finish_reason == "length":
            # Seen with Gemini: a reasoning model can spend the whole budget
            # thinking and return an empty answer.
            raise RuntimeError(
                f"the model used all {max_tokens} output tokens before answering; "
                "raise LLM_MAX_TOKENS for reasoning models"
            )
        raise RuntimeError("the model returned no text")

    usage = getattr(response, "usage", None)
    return LLMResult(
        text=text,
        provider=OPENAI_COMPATIBLE,
        model=model,
        input_tokens=getattr(usage, "prompt_tokens", None),
        output_tokens=getattr(usage, "completion_tokens", None),
    )


def complete(
    system: str,
    user: str,
    *,
    max_tokens: int | None = None,
    task: str | None = None,
    images: tuple[Image, ...] = (),
) -> LLMResult:
    which = provider(task)
    max_tokens = max_tokens or max_output_tokens(task)
    if which == ANTHROPIC:
        return _complete_anthropic(system, user, max_tokens, images)
    if which == OPENAI_COMPATIBLE:
        if not model_name(task):
            raise LLMUnavailable("LLM_MODEL is not set for the OpenAI-compatible provider")
        return _complete_openai(system, user, max_tokens, task, images)
    raise LLMUnavailable(
        "no language model configured: set ANTHROPIC_API_KEY, or LLM_BASE_URL + "
        "LLM_API_KEY + LLM_MODEL for an OpenAI-compatible endpoint"
    )
