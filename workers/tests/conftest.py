from __future__ import annotations

import os

import pytest

from workers.common import llm
from workers.common import strategies as registry

# By prefix, not by name: task profiles mean any LLM_<TASK>_* variable can
# redirect a call, and a fixed list silently stops covering new ones.
LLM_ENV_PREFIXES = ("LLM_", "ANTHROPIC_", "CLAUDE_")


@pytest.fixture(autouse=True)
def isolated_registry():
    """The registry is module-global, so a fake strategy registered by one test
    would otherwise leak into every test after it - and into real resolution."""
    saved = (
        dict(registry._REGISTRY),
        dict(registry._DEFAULTS),
        dict(registry._EXPLICIT_DEFAULTS),
        set(registry._LOADED),
        registry._SCOPE,
        dict(registry._FALLBACKS),
    )
    yield
    registry._SCOPE = saved[4]
    registry._FALLBACKS.clear()
    registry._FALLBACKS.update(saved[5])
    registry._REGISTRY.clear()
    registry._REGISTRY.update(saved[0])
    registry._DEFAULTS.clear()
    registry._DEFAULTS.update(saved[1])
    registry._EXPLICIT_DEFAULTS.clear()
    registry._EXPLICIT_DEFAULTS.update(saved[2])
    registry._LOADED.clear()
    registry._LOADED.update(saved[3])


@pytest.fixture(autouse=True)
def no_llm_credentials(monkeypatch):
    """A developer's real key in the environment must never make a test hit an API."""
    for name in [n for n in os.environ if n.startswith(LLM_ENV_PREFIXES)]:
        monkeypatch.delenv(name, raising=False)
    llm.reset_clients()
    yield
    llm.reset_clients()
