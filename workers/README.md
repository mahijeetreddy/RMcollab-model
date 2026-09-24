# RMcollab workers

Celery workers that run `rmcollab.enhance` jobs and publish `JobEvent`s to the
`rmcollab:job-events` Redis stream. One task, many swappable strategies.

    workers/common/     contracts, config, Celery app, strategy registry, event emitter
    workers/strategies/<media_type>/<name>.py   one file per enhancement approach
    workers/tasks.py    the rmcollab.enhance task
    workers/celery_worker.py   local entrypoint (`python -m workers.celery_worker`)

Env: `REDIS_URL`, `STORAGE_ROOT`, `CELERY_QUEUES` (comma-separated), `CELERY_CONCURRENCY`.
The container runs `celery -A workers.common.app:app worker -Q $CELERY_QUEUES`; both paths
register the task and load strategies for the queues being drained.

## Adding a strategy

New file, decorator, nothing else. `load_strategies()` imports every non-underscore
module under `workers/strategies/<media_type>/`, so the registry picks it up.

```python
# workers/strategies/image/realesrgan.py
from __future__ import annotations
from pathlib import Path
from typing import Any
from workers.common.strategies import BaseEnhancer, EnhanceResult, ProgressFn, register

@register  # @register(default=True) to make it the "auto" pick for this media type
class RealEsrgan(BaseEnhancer):
    name = "realesrgan"
    label = "Real-ESRGAN x4"
    description = "4x upscale with the x4plus weights."
    media_type = "image"

    def enhance(self, input_path: Path, output_path: Path,
                params: dict[str, Any], progress: ProgressFn) -> EnhanceResult:
        for i, tile in enumerate(tiles, 1):
            ...
            progress(i / len(tiles), f"tile {i}/{len(tiles)}")   # 0..1, throttled to ~2/s
        return EnhanceResult(output_path=output_path, message="upscaled 4x")
```

Paths handed to `enhance()` are absolute and already validated against `STORAGE_ROOT`;
the parent directory of `output_path` exists. Heavy deps go in a per-media-type
`requirements-<type>.txt`, not the shared one.

## Producing more than one output

`EnhanceResult(output_path=...)` above is the single-output form: `workers/tasks.py` wraps it
into one `enhanced` artifact, which the client shows as a before/after comparison. A strategy
that derives several documents returns `artifacts` instead:

```python
from workers.common.strategies import ProducedArtifact

return EnhanceResult(
    artifacts=[
        ProducedArtifact(path=transcript, kind="transcript", label="Transcript",
                         mime_type="text/plain", meta={"language": "en"}),
        ProducedArtifact(path=summary, kind="summary", label="Summary",
                         mime_type="text/markdown"),
    ],
    message="transcribed and summarised",
)
```

Write each file next to `output_path` (e.g. `output_path.with_name("summary.md")`). Keep
`meta` small: it rides on every WebSocket job event and room snapshot, so anything large
(transcript segment timings, say) belongs in the file, not in `meta`. `kind` must be one of
the `ArtifactKind` values in `shared/src/domain.ts`; add a kind there and in
`workers/common/contracts.py` together, and `npm run check:contracts` will confirm they match.

## Language models

Never import a vendor SDK in a strategy. Call `workers/common/llm.py`, which is the single
place a provider is chosen, so Anthropic and any OpenAI-compatible gateway stay
interchangeable by config:

```python
from workers.common import llm

result = llm.complete(SYSTEM_PROMPT, source_text, max_tokens=4096)
result.text, result.provider, result.model, result.input_tokens
```

`llm.complete` raises `llm.LLMUnavailable` when nothing is configured. See
`workers/strategies/text/summarise.py` for chunk-and-reduce over input longer than a model's
context window.

## Availability

Override `available()` when a strategy needs something the worker might not have — a
language model, model weights, a GPU:

```python
    @classmethod
    def available(cls) -> bool:
        return llm.available()          # not os.getenv("SOME_VENDOR_KEY")
```

Unavailable strategies stay registered and visible so the UI can grey them out with a
reason, but they never win default resolution. A job asking for `auto`, an unknown name,
or an unavailable strategy runs the media type's default instead, and the `JobEvent`
reports which strategy actually ran and why it wasn't the requested one.

## Advertisement

On startup each worker publishes the strategies it can run to
`rmcollab:strategies:<media_type>:<name>` in Redis under a 90s TTL, refreshed every 30s
(`workers/common/advertise.py`). The gateway mirrors those keys into `GET /api/strategies`,
so the picker shows the pools that are actually online — start a worker and its strategies
appear; stop it and they expire.
