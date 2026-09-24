"""Worker configuration, read once from the environment."""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import get_args

from workers.common.contracts import QUEUES, MediaType

log = logging.getLogger(__name__)

MEDIA_TYPES: tuple[MediaType, ...] = get_args(MediaType)
_QUEUE_TO_MEDIA: dict[str, MediaType] = {queue: media for media, queue in QUEUES.items()}

DEFAULT_REDIS_URL = "redis://localhost:6379/0"
DEFAULT_STORAGE_ROOT = "/data/storage"
DEFAULT_CONCURRENCY = 4


class StoragePathError(ValueError):
    """A task-supplied path resolved outside STORAGE_ROOT."""


@dataclass(frozen=True)
class Config:
    redis_url: str
    storage_root: Path
    celery_queues: tuple[str, ...]
    celery_concurrency: int

    @property
    def media_types(self) -> tuple[MediaType, ...]:
        """The media types this container drains, derived from CELERY_QUEUES."""
        known = [_QUEUE_TO_MEDIA[q] for q in self.celery_queues if q in _QUEUE_TO_MEDIA]
        return tuple(dict.fromkeys(known))

    def resolve(self, storage_relative: str) -> Path:
        root = self.storage_root.resolve()
        candidate = (root / storage_relative).resolve()
        if candidate != root and root not in candidate.parents:
            raise StoragePathError(f"path escapes STORAGE_ROOT: {storage_relative!r}")
        return candidate

    def relativize(self, path: Path) -> str:
        """Absolute worker path -> the storage-relative form the gateway serves."""
        root = self.storage_root.resolve()
        try:
            return path.resolve().relative_to(root).as_posix()
        except ValueError as exc:
            raise StoragePathError(f"path outside STORAGE_ROOT: {path}") from exc


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        log.warning("%s=%r is not an integer, using %d", name, raw, default)
        return default


def _env_queues(name: str) -> tuple[str, ...]:
    raw = os.getenv(name, "").strip()
    if not raw:
        return tuple(QUEUES.values())
    queues = tuple(dict.fromkeys(part.strip() for part in raw.split(",") if part.strip()))
    unknown = [q for q in queues if q not in _QUEUE_TO_MEDIA]
    if unknown:
        log.warning("%s contains queues with no media type mapping: %s", name, unknown)
    return queues or tuple(QUEUES.values())


def load_config() -> Config:
    concurrency = _env_int("CELERY_CONCURRENCY", DEFAULT_CONCURRENCY)
    return Config(
        redis_url=os.getenv("REDIS_URL", "").strip() or DEFAULT_REDIS_URL,
        storage_root=Path(os.getenv("STORAGE_ROOT", "").strip() or DEFAULT_STORAGE_ROOT),
        celery_queues=_env_queues("CELERY_QUEUES"),
        celery_concurrency=max(1, concurrency),
    )


@lru_cache(maxsize=1)
def get_config() -> Config:
    return load_config()
