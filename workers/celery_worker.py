"""Container entrypoint: drain CELERY_QUEUES at CELERY_CONCURRENCY."""

from __future__ import annotations

import logging

from workers.common.app import app
from workers.common.config import get_config
from workers.common.strategies import load_strategies, registered_strategies, restrict_loading
from workers.tasks import enhance  # noqa: F401 - import registers rmcollab.enhance

log = logging.getLogger(__name__)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    config = get_config()
    # Set before the pool forks, so every child inherits it.
    restrict_loading(config.media_types)
    load_strategies(config.media_types)

    for info in registered_strategies():
        log.info(
            "strategy %s/%s%s - %s",
            info.media_type, info.name, " (default)" if info.is_default else "", info.label,
        )

    app.worker_main(
        [
            "worker",
            "--loglevel=INFO",
            f"--queues={','.join(config.celery_queues)}",
            f"--concurrency={config.celery_concurrency}",
            "--hostname=rmcollab-worker@%h",
        ]
    )


if __name__ == "__main__":
    main()
