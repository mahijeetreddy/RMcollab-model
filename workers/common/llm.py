"""The one place a language-model provider is chosen.

Strategies call `complete()` and never import a vendor SDK themselves, so
switching between Anthropic and any OpenAI-compatible endpoint (OpenRouter,
Together, a local vLLM) is a config change rather than an edit spread across
every strategy that happens to use a model.

Selection, in order:
  LLM_PROVIDER=anthropic|openai      explicit wins
  ANTHROPIC_API_KEY set              -> anthropic
  LLM_API_KEY + LLM_BASE_URL set     -> openai-compatible
  otherwise                          -> unavailable, and strategies say so
"""

from __future__ import annotations

import importlib.util
import logging
import os
from dataclasses import dataclass

log = logging.getLogger(__name__)

ANTHROPIC = "anthropic"
OPENAI_COMPATIBLE = "openai"

DEFAULT_ANTHROPIC_MODEL = "claude-opus-5"
DEFAULT_MAX_TOKENS = 4096


class LLMUnavailable(RuntimeError):
    """No provider is configured, or the configured one rejected us."""


@dataclass(frozen=True)
class LLMResult:
    text: str
    provider: str
    model: str
    input_tokens: int | None = None
    output_tokens: int | None = None


def _env(name: str) -> str:
    return (os.getenv(name) or "").strip()


def provider() -> str | None:
    explicit = _env("LLM_PROVIDER").lower()
    if explicit in (ANTHROPIC, OPENAI_COMPATIBLE):
        return explicit
    if _env("ANTHROPIC_API_KEY") or _env("ANTHROPIC_AUTH_TOKEN"):
        return ANTHROPIC
    if _env("LLM_API_KEY") and _env("LLM_BASE_URL"):
        return OPENAI_COMPATIBLE
    return None


def model_name() -> str:
    which = provider()
    if which == ANTHROPIC:
        return _env("CLAUDE_MODEL") or DEFAULT_ANTHROPIC_MODEL
    if which == OPENAI_COMPATIBLE:
        # No default: the operator names the model, because which free models an
        # OpenAI-compatible gateway offers changes over time.
        return _env("LLM_MODEL")
    return ""


def available() -> bool:
    which = provider()
    if which == ANTHROPIC:
        return importlib.util.find_spec("anthropic") is not None
    if which == OPENAI_COMPATIBLE:
        return bool(model_name()) and importlib.util.find_spec("openai") is not None
    return False


def describe() -> str:
    return f"{provider() or 'none'}/{model_name() or 'unconfigured'}"


def _complete_anthropic(system: str, user: str, max_tokens: int) -> LLMResult:
    import anthropic

    model = model_name()
    client = anthropic.Anthropic()
    try:
        # Streamed so a long reduction cannot trip the SDK's request timeout.
        with client.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            output_config={"effort": _env("CLAUDE_EFFORT") or "low"},
            messages=[{"role": "user", "content": user}],
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


def _complete_openai(system: str, user: str, max_tokens: int) -> LLMResult:
    from openai import OpenAI

    model = model_name()
    client = OpenAI(api_key=_env("LLM_API_KEY"), base_url=_env("LLM_BASE_URL"))
    try:
        response = client.chat.completions.create(
            model=model,
            max_tokens=max_tokens,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
    except Exception as exc:  # noqa: BLE001 - surface any gateway's error as a job failure
        raise RuntimeError(f"{_env('LLM_BASE_URL')} rejected the request: {exc}") from exc

    choice = response.choices[0] if response.choices else None
    text = ((choice.message.content if choice else None) or "").strip()
    if not text:
        raise RuntimeError("the model returned no text")

    usage = getattr(response, "usage", None)
    return LLMResult(
        text=text,
        provider=OPENAI_COMPATIBLE,
        model=model,
        input_tokens=getattr(usage, "prompt_tokens", None),
        output_tokens=getattr(usage, "completion_tokens", None),
    )


def complete(system: str, user: str, *, max_tokens: int = DEFAULT_MAX_TOKENS) -> LLMResult:
    which = provider()
    if which == ANTHROPIC:
        return _complete_anthropic(system, user, max_tokens)
    if which == OPENAI_COMPATIBLE:
        if not model_name():
            raise LLMUnavailable("LLM_MODEL is not set for the OpenAI-compatible provider")
        return _complete_openai(system, user, max_tokens)
    raise LLMUnavailable(
        "no language model configured: set ANTHROPIC_API_KEY, or LLM_BASE_URL + "
        "LLM_API_KEY + LLM_MODEL for an OpenAI-compatible endpoint"
    )
