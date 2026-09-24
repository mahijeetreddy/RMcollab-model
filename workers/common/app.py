"""The Celery application: broker topology, task routing, worker lifecycle."""

from __future__ import annotations

import logging
from typing import Any

from celery import Celery
from celery.signals import worker_process_init, worker_ready
from kombu import Queue

from workers.common.config import get_config
from workers.common.contracts import QUEUES, TASK_ENHANCE
from workers.common.events import reset_redis
from workers.common.strategies import load_strategies

log = logging.getLogger(__name__)

TASK_TIME_LIMIT_S = 900
TASK_SOFT_TIME_LIMIT_S = 840


def route_task(name: str, args: Any, kwargs: dict[str, Any] | None, options: Any, task: Any = None, **_: Any):
    if name != TASK_ENHANCE:
        return None
    queue = QUEUES.get((kwargs or {}).get("media_type", ""))
    return {"queue": queue} if queue else None


_config = get_config()

app = Celery(
    "rmcollab",
    broker=_config.redis_url,
    backend=_config.redis_url,
    include=("workers.tasks",),
)

app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    result_expires=3600,
    timezone="UTC",
    enable_utc=True,
    # acks_late + prefetch 1: a job is acknowledged only after it finishes, so
    # killing a worker mid-job redelivers it to another worker instead of
    # losing it. Prefetch 1 keeps an idle worker from hoarding queued jobs.
    task_acks_late=True,
    worker_prefetch_multiplier=1,
    task_reject_on_worker_lost=True,
    task_track_started=True,
    task_time_limit=TASK_TIME_LIMIT_S,
    task_soft_time_limit=TASK_SOFT_TIME_LIMIT_S,
    broker_connection_retry_on_startup=True,
    worker_cancel_long_running_tasks_on_connection_loss=True,
    task_default_queue=QUEUES["text"],
    task_queues=tuple(Queue(queue) for queue in QUEUES.values()),
    task_routes=(route_task,),
)


@worker_process_init.connect
def _on_worker_process_init(**_: Any) -> None:
    reset_redis()
    load_strategies(get_config().media_types)


@worker_ready.connect
def _on_worker_ready(**_: Any) -> None:
    # Main process only, so one heartbeat thread per container rather than one
    # per forked child.
    from workers.common.advertise import start_heartbeat

    start_heartbeat()
