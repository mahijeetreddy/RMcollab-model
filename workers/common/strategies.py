"""Pluggable enhancement strategies.

Adding an enhancer is: drop a module under `workers/strategies/<media_type>/`,
subclass `BaseEnhancer`, decorate with `@register`. Nothing else changes.
"""

from __future__ import annotations

import importlib
import logging
import pkgutil
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, ClassVar, Iterable

from workers.common.config import MEDIA_TYPES
from workers.common.contracts import MediaType

log = logging.getLogger(__name__)

STRATEGY_PACKAGE = "workers.strategies"
AUTO_STRATEGY = "auto"

ProgressFn = Callable[..., None]
"""Called as progress(fraction: float, message: str) from inside enhance()."""


class StrategyError(RuntimeError):
    """Registry or strategy-resolution failure."""


class StrategyNotFound(StrategyError):
    """No strategy registered for the requested (media_type, name)."""


@dataclass(frozen=True)
class ProducedArtifact:
    """One output file a strategy wrote, plus how to present it."""

    path: Path
    kind: str = "enhanced"
    label: str = "Enhanced"
    mime_type: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class EnhanceResult:
    #: The single output of an enhancing strategy. A strategy that produces
    #: several outputs (a transcript *and* a summary) sets `artifacts` instead;
    #: `workers/tasks.py` wraps this into one `enhanced` artifact when it is set,
    #: so single-output strategies need no changes.
    output_path: Path | None = None
    artifacts: list[ProducedArtifact] = field(default_factory=list)
    message: str | None = None
    metrics: dict[str, Any] = field(default_factory=dict)

    def produced(self) -> list[ProducedArtifact]:
        if self.artifacts:
            return list(self.artifacts)
        if self.output_path is not None:
            return [ProducedArtifact(path=self.output_path)]
        return []


@dataclass(frozen=True)
class StrategyInfo:
    name: str
    label: str
    description: str
    media_type: MediaType
    is_default: bool
    available: bool


class BaseEnhancer(ABC):
    name: ClassVar[str] = ""
    label: ClassVar[str] = ""
    description: ClassVar[str] = ""
    media_type: ClassVar[MediaType]

    @abstractmethod
    def enhance(
        self,
        input_path: Path,
        output_path: Path,
        params: dict[str, Any],
        progress: ProgressFn,
    ) -> EnhanceResult:
        """Read input_path, write output_path, call progress(0..1, message) as you go."""

    @classmethod
    def available(cls) -> bool:
        """False when a prerequisite is missing (API key, model weights, GPU).

        Unavailable strategies stay registered and visible so the UI can show why
        they are greyed out, but they never win default resolution.
        """
        return True

    @classmethod
    def info(cls) -> StrategyInfo:
        return StrategyInfo(
            name=cls.name,
            label=cls.label or cls.name,
            description=cls.description,
            media_type=cls.media_type,
            is_default=_resolve_default_name(cls.media_type) == cls.name,
            available=cls.available(),
        )


_REGISTRY: dict[tuple[MediaType, str], type[BaseEnhancer]] = {}
_DEFAULTS: dict[MediaType, str] = {}
_EXPLICIT_DEFAULTS: dict[MediaType, str] = {}
_LOADED: set[MediaType] = set()


def _validate(cls: type[BaseEnhancer]) -> None:
    if not isinstance(cls, type) or not issubclass(cls, BaseEnhancer):
        raise StrategyError(f"{cls!r} is not a BaseEnhancer subclass")
    if not cls.name:
        raise StrategyError(f"{cls.__qualname__} must set a non-empty `name`")
    media_type = getattr(cls, "media_type", None)
    if media_type not in MEDIA_TYPES:
        raise StrategyError(f"{cls.__qualname__}.media_type must be one of {MEDIA_TYPES}, got {media_type!r}")
    if getattr(cls.enhance, "__isabstractmethod__", False):
        raise StrategyError(f"{cls.__qualname__} must implement enhance()")


def register(
    cls: type[BaseEnhancer] | None = None,
    *,
    default: bool = False,
) -> Any:
    """Register an enhancer. Usable bare (`@register`) or as `@register(default=True)`."""

    def apply(target: type[BaseEnhancer]) -> type[BaseEnhancer]:
        _validate(target)
        key = (target.media_type, target.name)
        existing = _REGISTRY.get(key)
        if existing is not None and existing is not target:
            raise StrategyError(
                f"duplicate strategy {key}: {existing.__module__} and {target.__module__}"
            )
        _REGISTRY[key] = target

        if default:
            claimed = _EXPLICIT_DEFAULTS.get(target.media_type)
            if claimed is not None and claimed != target.name:
                raise StrategyError(
                    f"two defaults for {target.media_type!r}: {claimed!r} and {target.name!r}"
                )
            _EXPLICIT_DEFAULTS[target.media_type] = target.name
            _DEFAULTS[target.media_type] = target.name
        elif target.media_type not in _DEFAULTS:
            _DEFAULTS[target.media_type] = target.name
        return target

    return apply(cls) if cls is not None else apply


def load_strategies(media_types: Iterable[MediaType] | None = None) -> None:
    """Import strategy modules so their @register decorators run. Idempotent."""
    targets = tuple(media_types) if media_types is not None else MEDIA_TYPES
    for media_type in targets:
        if media_type in _LOADED:
            continue
        _LOADED.add(media_type)
        package_name = f"{STRATEGY_PACKAGE}.{media_type}"
        try:
            package = importlib.import_module(package_name)
        except ModuleNotFoundError:
            log.warning("no strategy package %s; jobs for %r will fail", package_name, media_type)
            continue
        for module in pkgutil.iter_modules(package.__path__):
            if module.name.startswith("_"):
                continue
            importlib.import_module(f"{package_name}.{module.name}")


def get_strategy(media_type: MediaType, name: str) -> type[BaseEnhancer]:
    load_strategies((media_type,))
    try:
        return _REGISTRY[(media_type, name)]
    except KeyError:
        raise StrategyNotFound(f"no {media_type!r} strategy named {name!r}") from None


def _resolve_default_name(media_type: MediaType) -> str | None:
    """The declared default, unless it is unavailable and something else isn't."""
    declared = _DEFAULTS.get(media_type)
    if declared is not None and _REGISTRY[(media_type, declared)].available():
        return declared
    for (mt, name), cls in _REGISTRY.items():
        if mt == media_type and cls.available():
            return name
    return declared


def default_strategy(media_type: MediaType) -> type[BaseEnhancer]:
    load_strategies((media_type,))
    name = _resolve_default_name(media_type)
    if name is None:
        raise StrategyNotFound(f"no strategies registered for {media_type!r}")
    return _REGISTRY[(media_type, name)]


def list_strategies(media_type: MediaType | None = None) -> list[StrategyInfo]:
    load_strategies((media_type,) if media_type else None)
    items = [
        cls.info()
        for (mt, _), cls in _REGISTRY.items()
        if media_type is None or mt == media_type
    ]
    return sorted(items, key=lambda i: (i.media_type, not i.is_default, i.name))


@dataclass(frozen=True)
class StrategyResolution:
    enhancer: BaseEnhancer
    requested: str
    fell_back: bool
    reason: str | None = None

    @property
    def name(self) -> str:
        return type(self.enhancer).name


def resolve_strategy(media_type: MediaType, requested: str | None) -> StrategyResolution:
    """"auto", empty, unknown, or unavailable all fall back to the media type's default.

    `fell_back` and `reason` are surfaced in the JobEvent so the UI can say which
    strategy actually ran and why it wasn't the requested one.
    """
    want = (requested or "").strip()
    load_strategies((media_type,))

    if want and want.lower() != AUTO_STRATEGY:
        cls = _REGISTRY.get((media_type, want))
        if cls is None:
            log.warning("unknown %s strategy %r; falling back to default", media_type, want)
            return StrategyResolution(
                enhancer=default_strategy(media_type)(),
                requested=want,
                fell_back=True,
                reason=f"{want!r} is not registered",
            )
        if not cls.available():
            log.warning("%s strategy %r unavailable; falling back to default", media_type, want)
            return StrategyResolution(
                enhancer=default_strategy(media_type)(),
                requested=want,
                fell_back=True,
                reason=f"{want!r} is not configured on this worker",
            )
        return StrategyResolution(enhancer=cls(), requested=want, fell_back=False)

    return StrategyResolution(
        enhancer=default_strategy(media_type)(), requested=want or AUTO_STRATEGY, fell_back=False
    )
