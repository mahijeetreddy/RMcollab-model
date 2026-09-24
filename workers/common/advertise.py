"""Capability advertisement.

Each worker publishes the strategies it can actually run to Redis under a short
TTL and refreshes them on a heartbeat. The gateway reads these keys to build its
strategy picker, so the UI reflects the pools that are genuinely online: scale up
a GPU image worker and its strategies appear; stop it and they expire. A worker
without ANTHROPIC_API_KEY advertises the Claude strategy as unavailable rather
than hiding it, so the UI can explain why it is greyed out.
"""

from __future__ import annotations

import json
import logging
import threading
from dataclasses import asdict

from workers.common.config import get_config
from workers.common.events import get_redis
from workers.common.strategies import list_strategies, load_strategies

log = logging.getLogger(__name__)

KEY_PREFIX = "rmcollab:strategies"
TTL_S = 90
HEARTBEAT_S = 30

_thread: threading.Thread | None = None
_stop = threading.Event()


def publish_strategies() -> int:
    config = get_config()
    media_types = config.media_types
    load_strategies(media_types)

    client = get_redis()
    pipe = client.pipeline()
    count = 0
    # Scoped per media type, never a bare list_strategies(): that loads *every*
    # media type, and the light text image has no numpy/torch to import the ML
    # strategies with, so advertising would die on a pool it does not serve.
    for media_type in media_types:
        for info in list_strategies(media_type):
            pipe.set(
                f"{KEY_PREFIX}:{info.media_type}:{info.name}",
                json.dumps(asdict(info)),
                ex=TTL_S,
            )
            count += 1
    pipe.execute()
    return count


def start_heartbeat() -> None:
    global _thread
    if _thread is not None:
        return

    def loop() -> None:
        while not _stop.is_set():
            try:
                count = publish_strategies()
                log.debug("advertised %d strategies", count)
            except Exception:  # noqa: BLE001 - advertisement must never kill a worker
                log.warning("strategy advertisement failed", exc_info=True)
            _stop.wait(HEARTBEAT_S)

    _thread = threading.Thread(target=loop, name="strategy-advertiser", daemon=True)
    _thread.start()


def stop_heartbeat() -> None:
    _stop.set()
