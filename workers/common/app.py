"""The Celery application: broker topology, task routing, worker lifecycle."""

from __future__ import annotations

import logging
from typing import Any

from celery import Celery
from celery.signals import worker_process_init, worker_ready
from kombu import Queue

from workers.common.config import get_config
from workers.common.contracts import QUEUE_ASK, QUEUE_EMBED, QUEUES, TASK_ENHANCE
from workers.common import llm
from workers.common.errors import start_error_tracking
from workers.common.events import reset_redis
from workers.common.strategies import load_strategies, restrict_loading

log = logging.getLogger(__name__)

TASK_TIME_LIMIT_S = 900
TASK_SOFT_TIME_LIMIT_S = 840


def route_task(name: str, args: Any, kwargs: dict[str, Any] | None, options: Any, task: Any = None, **_: Any):
    if name != TASK_ENHANCE:
        return None
    queue = QUEUES.get((kwargs or {}).get("media_type", ""))
    return {"queue": queue} if queue else None


# Before the app exists, so the Celery integration sees every task. A no-op without SENTRY_DSN.
start_error_tracking()

_config = get_config()
# The Ask pool runs threads, not processes: its work is waiting on a model API or
# on ONNX Runtime (which releases the GIL), and threads share one copy of the
# embedding model instead of loading one per process. worker_process_init does
# not fire for threads, so it warms up in worker_ready instead.
_ASK_POOL = bool({QUEUE_ASK, QUEUE_EMBED} & set(_config.celery_queues))

app = Celery(
    "rmcollab",
    broker=_config.redis_url,
    backend=_config.redis_url,
    include=("workers.tasks", "workers.ask_tasks"),
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
    task_queues=tuple(Queue(queue) for queue in (*QUEUES.values(), QUEUE_ASK, QUEUE_EMBED)),
    task_routes=(route_task,),
)
if _ASK_POOL:
    app.conf.worker_pool = "threads"


@worker_process_init.connect
def _on_worker_process_init(**_: Any) -> None:
    reset_redis()
    restrict_loading(get_config().media_types)
    load_strategies(get_config().media_types)
    # Every pool child gets its own model client, connected before its first job
    # rather than during it; see llm.warm for why this is off the boot path.
    llm.reset_clients()
    llm.warm()


@worker_ready.connect
def _on_worker_ready(**_: Any) -> None:
    # Main process only, so one heartbeat thread per container rather than one
    # per forked child.
    from workers.common.advertise import start_heartbeat

    start_heartbeat()
    if _ASK_POOL:
        # Threads share this process, so this is the one place to load the model.
        from workers.common import embeddings

        llm.warm()
        embeddings.warm()
