from __future__ import annotations

import pytest

from workers.common import llm

OPENAI = {"LLM_API_KEY": "k", "LLM_BASE_URL": "https://gateway.example/v1", "LLM_MODEL": "some-model"}


def configure(monkeypatch, **env: str) -> None:
    for key, value in env.items():
        monkeypatch.setenv(key, value)


class TestProviderSelection:
    def test_nothing_configured_means_no_provider(self):
        assert llm.provider() is None
        assert llm.available() is False

    def test_anthropic_key_selects_anthropic(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test")
        assert llm.provider() == llm.ANTHROPIC

    def test_openai_compatible_needs_key_and_base_url(self, monkeypatch):
        configure(monkeypatch, **OPENAI)
        assert llm.provider() == llm.OPENAI_COMPATIBLE

    def test_openai_key_alone_is_not_enough(self, monkeypatch):
        configure(monkeypatch, LLM_API_KEY="k")
        assert llm.provider() is None

    def test_anthropic_wins_when_both_are_configured(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test", **OPENAI)
        assert llm.provider() == llm.ANTHROPIC

    def test_explicit_provider_overrides_the_default_preference(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test", LLM_PROVIDER="openai", **OPENAI)
        assert llm.provider() == llm.OPENAI_COMPATIBLE

    def test_explicit_provider_is_case_insensitive(self, monkeypatch):
        configure(monkeypatch, LLM_PROVIDER="OpenAI", **OPENAI)
        assert llm.provider() == llm.OPENAI_COMPATIBLE

    def test_unrecognised_explicit_provider_is_ignored(self, monkeypatch):
        configure(monkeypatch, LLM_PROVIDER="bard", ANTHROPIC_API_KEY="sk-test")
        assert llm.provider() == llm.ANTHROPIC


class TestModelNames:
    def test_anthropic_has_a_default_model(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test")
        assert llm.model_name() == llm.DEFAULT_ANTHROPIC_MODEL

    def test_anthropic_model_can_be_overridden(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test", CLAUDE_MODEL="claude-sonnet-5")
        assert llm.model_name() == "claude-sonnet-5"

    def test_openai_compatible_has_no_default_model(self, monkeypatch):
        # Deliberate: which models a gateway offers changes over time, so the
        # operator must name one rather than inherit a stale hardcoded slug.
        configure(monkeypatch, LLM_API_KEY="k", LLM_BASE_URL="https://gateway.example/v1")
        assert llm.model_name() == ""
        assert llm.available() is False


class TestFailureModes:
    def test_complete_without_a_provider_raises_unavailable(self):
        with pytest.raises(llm.LLMUnavailable, match="no language model configured"):
            llm.complete("system", "user")

    def test_openai_without_a_model_raises_unavailable(self, monkeypatch):
        monkeypatch.setenv("LLM_PROVIDER", "openai")
        monkeypatch.setenv("LLM_API_KEY", "k")
        monkeypatch.setenv("LLM_BASE_URL", "https://gateway.example/v1")
        with pytest.raises(llm.LLMUnavailable, match="LLM_MODEL"):
            llm.complete("system", "user")

    def test_describe_names_provider_and_model(self, monkeypatch):
        configure(monkeypatch, **OPENAI)
        assert llm.describe() == "openai/some-model"
        monkeypatch.delenv("LLM_API_KEY")
        assert llm.describe() == "none/unconfigured"


class FakeStatusError(Exception):
    """Shaped like the SDKs' APIStatusError: a status code and a response."""

    def __init__(self, status: int, retry_after: str | None = None):
        super().__init__(f"HTTP {status}")
        self.status_code = status
        headers = {"retry-after": retry_after} if retry_after is not None else {}
        self.response = type("Response", (), {"headers": headers})()


class APIConnectionError(Exception):
    """Matched by class name, as the real SDK exception is."""


class TestRetries:
    @pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
    def test_throttling_and_overload_are_retried(self, status):
        assert llm.retry_delay(FakeStatusError(status), 0) is not None

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 413, 422])
    def test_client_errors_are_not(self, status):
        # Retrying a bad key or an oversized request only delays the failure.
        assert llm.retry_delay(FakeStatusError(status), 0) is None

    def test_connection_errors_are_retried_but_other_exceptions_are_not(self):
        assert llm.retry_delay(APIConnectionError(), 0) is not None
        assert llm.retry_delay(ValueError("bug"), 0) is None

    def test_backoff_grows_and_is_capped(self, monkeypatch):
        monkeypatch.setattr(llm.random, "uniform", lambda low, high: high)
        delays = [llm.retry_delay(FakeStatusError(503), n) for n in range(8)]
        assert delays[:4] == [2.0, 4.0, 8.0, 16.0]
        assert max(delays) == llm.RETRY_CAP_S

    def test_retry_after_wins_when_it_asks_for_longer(self, monkeypatch):
        monkeypatch.setattr(llm.random, "uniform", lambda low, high: high)
        assert llm.retry_delay(FakeStatusError(429, retry_after="21"), 0) == 21.0

    def test_a_retry_after_beyond_a_minute_is_a_daily_cap_and_not_waited_for(self):
        assert llm.retry_delay(FakeStatusError(429, retry_after="3600"), 0) is None

    @pytest.mark.parametrize(
        "body",
        [
            "quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier, retryDelay: 13s",
            "Rate limit reached on requests per day (RPD): Limit 1000, Used 1000",
            "Rate limit reached on tokens per day (TPD)",
        ],
    )
    def test_a_spent_daily_quota_fails_fast_despite_a_short_retry_hint(self, body):
        exc = FakeStatusError(429, retry_after="13")
        exc.args = (body,)
        assert llm.retry_delay(exc, 0) is None

    def test_a_per_minute_limit_is_still_retried(self):
        exc = FakeStatusError(429)
        exc.args = ("Rate limit reached on tokens per minute (TPM): Limit 8000",)
        assert llm.retry_delay(exc, 0) is not None

    def test_with_retries_recovers_after_transient_failures(self):
        failures = [FakeStatusError(503), FakeStatusError(429)]
        slept: list[float] = []

        def call() -> str:
            if failures:
                raise failures.pop(0)
            return "summary"

        assert llm.with_retries(call, sleep=slept.append) == "summary"
        assert len(slept) == 2

    def test_with_retries_gives_up_after_the_configured_attempts(self, monkeypatch):
        monkeypatch.setenv("LLM_MAX_RETRIES", "2")
        calls = []

        def call() -> str:
            calls.append(1)
            raise FakeStatusError(503)

        with pytest.raises(FakeStatusError):
            llm.with_retries(call, sleep=lambda _: None)
        assert len(calls) == 3

    def test_a_permanent_error_fails_on_the_first_attempt(self):
        calls = []

        def call() -> str:
            calls.append(1)
            raise FakeStatusError(401)

        with pytest.raises(FakeStatusError):
            llm.with_retries(call, sleep=lambda _: None)
        assert len(calls) == 1


class TestOutputBudget:
    def test_defaults_and_can_be_raised(self, monkeypatch):
        assert llm.max_output_tokens() == llm.DEFAULT_MAX_TOKENS
        monkeypatch.setenv("LLM_MAX_TOKENS", "16000")
        assert llm.max_output_tokens() == 16000

    def test_a_bad_value_falls_back_to_the_default(self, monkeypatch):
        monkeypatch.setenv("LLM_MAX_TOKENS", "lots")
        assert llm.max_output_tokens() == llm.DEFAULT_MAX_TOKENS

    def test_an_answer_lost_to_reasoning_says_so(self, monkeypatch):
        # Gemini did this: every token spent thinking, finish_reason "length",
        # and no content. "Returned no text" would hide the fix.
        pytest.importorskip("openai")
        configure(monkeypatch, **OPENAI)

        choice = type("Choice", (), {"finish_reason": "length", "message": type("M", (), {"content": ""})()})()
        response = type("Response", (), {"choices": [choice], "usage": None})()

        class FakeClient:
            def __init__(self, **_):
                self.chat = type("Chat", (), {"completions": type("C", (), {"create": staticmethod(lambda **_: response)})()})()

        import openai

        monkeypatch.setattr(openai, "OpenAI", FakeClient)
        with pytest.raises(RuntimeError, match="LLM_MAX_TOKENS"):
            llm.complete("system", "user", max_tokens=20)


GROQ = {"LLM_REWRITE_BASE_URL": "https://fast.example/v1", "LLM_REWRITE_API_KEY": "fast-key", "LLM_REWRITE_MODEL": "fast-model"}


class TestTaskProfiles:
    def test_a_task_falls_back_to_the_shared_settings(self, monkeypatch):
        configure(monkeypatch, **OPENAI)
        assert llm.describe(llm.REWRITE) == "openai/some-model"
        assert llm.describe(llm.SUMMARY) == "openai/some-model"

    def test_a_task_can_override_one_setting(self, monkeypatch):
        configure(monkeypatch, LLM_REWRITE_MODEL="small-model", **OPENAI)
        assert llm.model_name(llm.REWRITE) == "small-model"
        assert llm.model_name(llm.SUMMARY) == "some-model"
        assert llm.model_name() == "some-model"

    def test_a_task_can_use_a_different_provider_entirely(self, monkeypatch):
        # Rewrites to a fast endpoint while summaries stay on the default.
        configure(monkeypatch, **OPENAI, **GROQ)
        assert llm.setting("BASE_URL", llm.REWRITE) == "https://fast.example/v1"
        assert llm.setting("BASE_URL", llm.SUMMARY) == "https://gateway.example/v1"

    def test_a_task_endpoint_wins_over_an_anthropic_default(self, monkeypatch):
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test", **GROQ)
        assert llm.provider(llm.REWRITE) == llm.OPENAI_COMPATIBLE
        assert llm.provider(llm.SUMMARY) == llm.ANTHROPIC

    def test_limits_and_effort_are_per_task(self, monkeypatch):
        configure(monkeypatch, LLM_MAX_TOKENS="8000", LLM_REWRITE_MAX_TOKENS="1024", LLM_REWRITE_REASONING_EFFORT="Low", **OPENAI)
        assert llm.max_output_tokens(llm.REWRITE) == 1024
        assert llm.max_output_tokens(llm.SUMMARY) == 8000
        assert llm.reasoning_effort(llm.REWRITE) == "low"
        assert llm.reasoning_effort(llm.SUMMARY) is None


class FakeCompletions:
    def __init__(self, calls: list[dict]):
        self.calls = calls

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = type("M", (), {"content": "rewritten"})()
        choice = type("C", (), {"finish_reason": "stop", "message": message})()
        return type("R", (), {"choices": [choice], "usage": None})()


class FakeOpenAI:
    built: list[tuple[str, str]] = []

    def __init__(self, *, api_key, base_url, **_):
        FakeOpenAI.built.append((base_url, api_key))
        self.calls: list[dict] = []
        self.chat = type("Chat", (), {"completions": FakeCompletions(self.calls)})()


@pytest.fixture
def fake_openai(monkeypatch):
    openai = pytest.importorskip("openai")
    FakeOpenAI.built = []
    monkeypatch.setattr(openai, "OpenAI", FakeOpenAI)
    return FakeOpenAI


class TestClients:
    def test_one_client_per_endpoint_is_reused_across_calls(self, monkeypatch, fake_openai):
        # A client per call meant a TCP + TLS handshake on every rewrite.
        configure(monkeypatch, **OPENAI)
        for _ in range(3):
            llm.complete("s", "u")
        assert fake_openai.built == [("https://gateway.example/v1", "k")]

    def test_each_endpoint_gets_its_own_client(self, monkeypatch, fake_openai):
        configure(monkeypatch, **OPENAI, **GROQ)
        llm.complete("s", "u", task=llm.REWRITE)
        llm.complete("s", "u", task=llm.SUMMARY)
        assert sorted(fake_openai.built) == [("https://fast.example/v1", "fast-key"), ("https://gateway.example/v1", "k")]

    def test_reasoning_effort_is_sent_only_when_configured(self, monkeypatch, fake_openai):
        # Not every gateway accepts the parameter, so an unset effort sends nothing.
        configure(monkeypatch, LLM_REWRITE_REASONING_EFFORT="low", **OPENAI)
        llm.complete("s", "u", task=llm.REWRITE)
        llm.complete("s", "u", task=llm.SUMMARY)
        client = llm._openai_client("https://gateway.example/v1", "k")
        assert client.calls[0]["reasoning_effort"] == "low"
        assert "reasoning_effort" not in client.calls[1]

    def test_reset_drops_cached_clients(self, monkeypatch, fake_openai):
        # Called in every forked pool child, so no connection crosses a fork.
        configure(monkeypatch, **OPENAI)
        llm.complete("s", "u")
        llm.reset_clients()
        llm.complete("s", "u")
        assert len(fake_openai.built) == 2


def cached(fn):
    """Stand-in for the lru_cache'd client factory, which reset_clients clears."""
    fn.cache_clear = lambda: None
    return fn


class TestWarmUp:
    def test_nothing_configured_means_nothing_to_warm(self):
        assert llm.warm() is None

    def test_warm_up_connects_each_endpoint_once(self, monkeypatch):
        configure(monkeypatch, **OPENAI, **GROQ)
        touched: list[str] = []

        class Client:
            def __init__(self, base_url):
                self.base_url = base_url
                self.models = self

            def with_options(self, **_):
                return self

            def list(self):
                touched.append(self.base_url)

        monkeypatch.setattr(llm, "_openai_client", cached(lambda base_url, key: Client(base_url)))
        llm.warm(block=True)
        assert sorted(touched) == ["https://fast.example/v1", "https://gateway.example/v1"]

    def test_a_failing_warm_up_never_raises(self, monkeypatch):
        # A provider being down at boot must not kill the pool child.
        configure(monkeypatch, **OPENAI)

        def boom(*_):
            raise ConnectionError("unreachable")

        monkeypatch.setattr(llm, "_openai_client", cached(boom))
        llm.warm(block=True)


class TestVision:
    def test_a_text_model_is_never_assumed_to_read_images(self, monkeypatch):
        # Groq's gpt-oss is text-only: the shared model must not count.
        configure(monkeypatch, **OPENAI)
        assert llm.vision_available() is False

    def test_a_named_vision_model_makes_it_available(self, monkeypatch, fake_openai):
        configure(
            monkeypatch,
            LLM_VISION_BASE_URL="https://vision.example/v1",
            LLM_VISION_API_KEY="v-key",
            LLM_VISION_MODEL="a-vision-model",
            **OPENAI,
        )
        assert llm.vision_available() is True
        assert llm.describe(llm.VISION) == "openai/a-vision-model"

    def test_claude_reads_images_without_extra_configuration(self, monkeypatch):
        pytest.importorskip("anthropic")
        configure(monkeypatch, ANTHROPIC_API_KEY="sk-test")
        assert llm.vision_available() is True

    def test_images_travel_as_data_urls_after_the_prompt(self, monkeypatch, fake_openai):
        configure(monkeypatch, LLM_VISION_MODEL="a-vision-model", **OPENAI)
        llm.complete("s", "read this", task=llm.VISION, images=(llm.Image(b"\x89PNG", "image/png"),))
        call = llm._openai_client("https://gateway.example/v1", "k").calls[0]
        content = call["messages"][1]["content"]
        assert content[0] == {"type": "text", "text": "read this"}
        assert content[1]["image_url"]["url"] == "data:image/png;base64,iVBORw=="

    def test_text_only_calls_keep_a_plain_string(self, monkeypatch, fake_openai):
        configure(monkeypatch, **OPENAI)
        llm.complete("s", "just text")
        call = llm._openai_client("https://gateway.example/v1", "k").calls[0]
        assert call["messages"][1]["content"] == "just text"
