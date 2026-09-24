"""The single enhancement task. One task, many strategies."""

from __future__ import annotations

import dataclasses
import logging
from pathlib import Path
from typing import Any

import redis.exceptions as redis_exc

from workers.common.app import app
from workers.common.config import get_config
from workers.common.contracts import TASK_ENHANCE, EnhanceTaskPayload, JobEventArtifact
from workers.common.events import JobEventEmitter
from workers.common.strategies import load_strategies, resolve_strategy

log = logging.getLogger(__name__)

TRANSIENT_ERRORS = (
    redis_exc.ConnectionError,
    redis_exc.TimeoutError,
    ConnectionError,
    TimeoutError,
)
MAX_RETRIES = 3

_PAYLOAD_FIELDS = {f.name for f in dataclasses.fields(EnhanceTaskPayload)}


class EnhanceFailed(RuntimeError):
    """A strategy returned without producing its output file."""


def _payload_from_kwargs(kwargs: dict[str, Any]) -> EnhanceTaskPayload:
    payload = EnhanceTaskPayload(**{k: v for k, v in kwargs.items() if k in _PAYLOAD_FIELDS})
    if not isinstance(payload.params, dict):
        payload.params = {}
    return payload


def _describe(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__


@app.task(
    bind=True,
    name=TASK_ENHANCE,
    autoretry_for=TRANSIENT_ERRORS,
    retry_backoff=True,
    retry_backoff_max=60,
    retry_jitter=True,
    max_retries=MAX_RETRIES,
)
def enhance(self, **kwargs: Any) -> dict[str, Any]:
    payload = _payload_from_kwargs(kwargs)
    config = get_config()
    emitter = JobEventEmitter(payload)

    try:
        load_strategies((payload.media_type,))
        resolution = resolve_strategy(payload.media_type, payload.strategy)
        emitter.strategy = resolution.name

        input_path = config.resolve(payload.input_path)
        output_path = config.resolve(payload.output_path)
        if not input_path.is_file():
            raise FileNotFoundError(f"input not found under STORAGE_ROOT: {payload.input_path}")
        output_path.parent.mkdir(parents=True, exist_ok=True)

        started = (
            f"running {resolution.name}"
            if not resolution.fell_back
            else f"{resolution.reason}, running {resolution.name} instead"
        )
        emitter.processing(started)

        result = resolution.enhancer.enhance(
            input_path, output_path, dict(payload.params), emitter.progress
        )

        produced = result.produced()
        if not produced:
            raise EnhanceFailed(f"{resolution.name} returned no artifacts")

        artifacts: list[JobEventArtifact] = []
        for item in produced:
            path = Path(item.path)
            if not path.is_file():
                raise EnhanceFailed(f"{resolution.name} wrote no output at {path}")
            artifacts.append(
                JobEventArtifact(
                    kind=item.kind,
                    label=item.label,
                    path=config.relativize(path),
                    mimeType=item.mime_type,
                    meta=item.meta,
                )
            )

        emitter.done(artifacts, result.message or f"enhanced with {resolution.name}")

        return {
            "jobId": payload.job_id,
            "mediaItemId": payload.media_item_id,
            "status": "done",
            "strategy": resolution.name,
            "artifacts": [a.path for a in artifacts],
        }

    except TRANSIENT_ERRORS as exc:
        # autoretry_for reschedules this below; only the final attempt is terminal.
        if self.request.retries >= MAX_RETRIES:
            emitter.failed(_describe(exc), message="giving up after retries")
        else:
            log.warning(
                "job %s attempt %d transient failure: %s",
                payload.job_id, self.request.retries + 1, exc,
            )
        raise
    except Exception as exc:  # noqa: BLE001 - the UI needs a failed event for every terminal error
        log.exception("job %s failed", payload.job_id)
        emitter.failed(_describe(exc))
        raise
