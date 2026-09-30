"""Text embeddings for Ask the room, computed locally.

snowflake-arctic-embed-m through fastembed: ONNX on the CPU, no torch, about
40ms a question. Chosen over bge-small (the first plan) by measurement: on the
labelled set in e2e/fixtures/ask-eval.json it ranks the right passage first for
17 of 18 questions and in the top three for all of them, including paraphrases
like "how fast was it under load?" for "p95 latency of 180ms" that the smaller
models missed. workers/tools/eval_embeddings.py reruns the comparison.

Local rather than an API because a room's lectures and notes are the room's
own - an embedding API would send all of it to a third party, and the free ones
keep it for training - and because it has no quota to run out of.

Vectors are L2-normalised, so cosine distance in pgvector ranks them exactly.
"""

from __future__ import annotations

import base64
import logging
import os
import threading
from functools import lru_cache
from typing import Any, Sequence

from workers.common.contracts import EMBEDDING_DIMENSIONS, EMBEDDING_MODEL

log = logging.getLogger(__name__)

# The model's retrieval instruction, for the query side only: a short question and a
# paragraph are different kinds of text, and the prefix tells the model which
# one it is embedding. Passages are embedded as they are.
QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: "
BATCH_SIZE = 32


# One model per process, shared by the pool's threads: ONNX Runtime releases the
# GIL while it computes, so threads embed in parallel without a copy each.
_load_lock = threading.Lock()


@lru_cache(maxsize=1)
def _load() -> Any:
    from fastembed import TextEmbedding

    # Kept on the models volume, so a rebuilt container does not download again.
    cache = os.getenv("FASTEMBED_CACHE_PATH") or os.path.join(os.getenv("XDG_CACHE_HOME", "/tmp"), "fastembed")
    return TextEmbedding(model_name=EMBEDDING_MODEL, cache_dir=cache)


def _model() -> Any:
    # Two threads asking at once must not both load it.
    with _load_lock:
        return _load()


def reset() -> None:
    """Drops the loaded model, for a process that must load its own."""
    _load.cache_clear()


def warm() -> threading.Thread:
    """Loads the model off the start-up path, so the first question is not the one that pays for it."""

    def run() -> None:
        try:
            embed_passages(["warm up"])
            log.info("embedding model %s ready", EMBEDDING_MODEL)
        except Exception as exc:  # noqa: BLE001 - warming is best effort
            log.warning("embedding model warm-up failed: %s", exc)

    thread = threading.Thread(target=run, name="embed-warmup", daemon=True)
    thread.start()
    return thread


def _vectors(texts: Sequence[str]) -> list[list[float]]:
    out = [list(map(float, v)) for v in _model().embed(list(texts), batch_size=BATCH_SIZE)]
    for vector in out:
        if len(vector) != EMBEDDING_DIMENSIONS:
            raise RuntimeError(f"{EMBEDDING_MODEL} returned {len(vector)} dimensions, expected {EMBEDDING_DIMENSIONS}")
    return out


def embed_passages(texts: Sequence[str]) -> list[list[float]]:
    return _vectors(texts) if texts else []


def embed_query(question: str) -> list[float]:
    return _vectors([QUERY_INSTRUCTION + question])[0]


def encode(vector: Sequence[float]) -> str:
    """base64 of little-endian float32s: how vectors cross Redis (see EmbeddedVector)."""
    import array
    import sys

    packed = array.array("f", vector)
    if sys.byteorder != "little":  # pragma: no cover - every supported host is little-endian
        packed.byteswap()
    return base64.b64encode(packed.tobytes()).decode("ascii")


def decode(encoded: str) -> list[float]:
    import array
    import sys

    packed = array.array("f")
    packed.frombytes(base64.b64decode(encoded))
    if sys.byteorder != "little":  # pragma: no cover
        packed.byteswap()
    return packed.tolist()
