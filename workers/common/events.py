"""JobEvent publishing to the Redis stream the gateway fans out to WebSockets."""

from __future__ import annotations

import logging
import time

import redis

from workers.common.config import get_config
from workers.common.contracts import (
    JOB_EVENT_STREAM,
    EnhanceTaskPayload,
    JobEvent,
    JobEventArtifact,
    JobStatus,
)

log = logging.getLogger(__name__)

STREAM_MAXLEN = 10_000
MIN_PROGRESS_INTERVAL_S = 0.5
MIN_PROGRESS_DELTA = 0.25
MAX_ERROR_CHARS = 2_000

_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.Redis.from_url(get_config().redis_url, decode_responses=True)
    return _client


def reset_redis() -> None:
    """Drop the cached client; forked worker children must not share a socket."""
    global _client
    if _client is not None:
        try:
            _client.close()
        except Exception:  # noqa: BLE001 - closing an inherited socket is best effort
            pass
    _client = None


def _clamp(value: float) -> float:
    try:
        return min(1.0, max(0.0, float(value)))
    except (TypeError, ValueError):
        return 0.0


class JobEventEmitter:
    """Per-job emitter. `progress` is throttled; lifecycle events never are."""

    def __init__(
        self,
        payload: EnhanceTaskPayload,
        *,
        strategy: str | None = None,
        client: redis.Redis | None = None,
        stream: str = JOB_EVENT_STREAM,
        maxlen: int = STREAM_MAXLEN,
        min_interval_s: float = MIN_PROGRESS_INTERVAL_S,
        min_delta: float = MIN_PROGRESS_DELTA,
    ) -> None:
        self._payload = payload
        self.strategy = strategy or payload.strategy
        self._client = client
        self._stream = stream
        self._maxlen = maxlen
        self._min_interval_s = min_interval_s
        self._min_delta = min_delta
        self._last_emit_at = 0.0
        self._last_progress = -1.0

    @property
    def client(self) -> redis.Redis:
        if self._client is None:
            self._client = get_redis()
        return self._client

    def processing(self, message: str | None = None, progress: float = 0.0) -> None:
        self._emit("processing", progress, message=message)
        self._last_emit_at = time.monotonic()
        self._last_progress = _clamp(progress)

    def progress(self, fraction: float, message: str | None = None, *, force: bool = False) -> None:
        """Rate-limit progress so a per-frame video job can't flood the stream.

        A per-frame caller is capped at ~2 events/sec by the interval; the delta
        escape hatch only fires for a strategy that leaps a quarter of the job in
        one call, so a coarse job still reports immediately.
        """
        value = _clamp(fraction)
        now = time.monotonic()
        elapsed = now - self._last_emit_at
        delta = value - self._last_progress
        if not force and elapsed < self._min_interval_s and delta < self._min_delta:
            return
        self._emit("processing", value, message=message)
        self._last_emit_at = now
        self._last_progress = value

    def done(self, artifacts: list[JobEventArtifact], message: str | None = None) -> None:
        self._emit("done", 1.0, message=message, artifacts=artifacts)

    def failed(self, error: str, message: str | None = None) -> None:
        self._emit("failed", self._last_progress if self._last_progress > 0 else 0.0,
                   message=message, error=error[:MAX_ERROR_CHARS])

    def _emit(
        self,
        status: JobStatus,
        progress: float,
        *,
        message: str | None = None,
        artifacts: list[JobEventArtifact] | None = None,
        error: str | None = None,
    ) -> None:
        p = self._payload
        event = JobEvent(
            jobId=p.job_id,
            mediaItemId=p.media_item_id,
            roomId=p.room_id,
            sessionId=p.session_id,
            mediaType=p.media_type,
            strategy=self.strategy,
            status=status,
            progress=round(_clamp(progress), 4),
            message=message,
            artifacts=artifacts,
            error=error,
        )
        try:
            self.client.xadd(
                self._stream,
                event.to_stream_fields(),
                maxlen=self._maxlen,
                approximate=True,
            )
        except redis.RedisError as exc:
            # Never let a broker blip mask the real outcome of the job.
            level = logging.ERROR if status in ("done", "failed") else logging.WARNING
            log.log(level, "job %s: failed to publish %s event: %s", p.job_id, status, exc)
