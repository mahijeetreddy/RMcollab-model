"""Compares local embedding models on Ask the room's labelled question set.

    docker compose -f infra/docker-compose.yml exec -T ask-worker \\
        python -m workers.tools.eval_embeddings < e2e/fixtures/ask-eval.json

For each model: how often the passage holding the answer ranks first (R@1) and
in the top three (R@3), the mean reciprocal rank, and the time to embed one
question. Vector search only - the gateway also ranks by keywords and merges the
two, which the retrieval e2e test measures. Models download on first use.
"""

from __future__ import annotations

import json
import sys
import time

RETRIEVAL_PREFIX = "Represent this sentence for searching relevant passages: "

# (model, query prefix, passage prefix): each model's own recommended prompts.
CANDIDATES = [
    ("BAAI/bge-small-en-v1.5", "", ""),
    ("BAAI/bge-small-en-v1.5", RETRIEVAL_PREFIX, ""),
    ("BAAI/bge-base-en-v1.5", RETRIEVAL_PREFIX, ""),
    ("snowflake/snowflake-arctic-embed-s", RETRIEVAL_PREFIX, ""),
    ("snowflake/snowflake-arctic-embed-m", RETRIEVAL_PREFIX, ""),
    ("nomic-ai/nomic-embed-text-v1.5-Q", "search_query: ", "search_document: "),
    ("sentence-transformers/all-MiniLM-L6-v2", "", ""),
    ("jinaai/jina-embeddings-v2-small-en", "", ""),
]


def _unit(vector: list[float]) -> list[float]:
    length = sum(x * x for x in vector) ** 0.5
    return [x / length for x in vector]


def evaluate(data: dict, name: str, query_prefix: str, passage_prefix: str, cache: str) -> dict:
    from fastembed import TextEmbedding

    passages, questions = data["passages"], data["questions"]
    ids = [p["id"] for p in passages]
    model = TextEmbedding(model_name=name, cache_dir=cache)
    docs = [_unit(list(v)) for v in model.embed([passage_prefix + p["text"] for p in passages])]
    list(model.embed([query_prefix + "warm up"]))

    top1 = top3 = reciprocal = 0.0
    misses: list[str] = []
    started = time.monotonic()
    for item in questions:
        query = _unit(list(next(iter(model.embed([query_prefix + item["q"]])))))
        order = sorted(range(len(docs)), key=lambda i: -sum(a * b for a, b in zip(query, docs[i])))
        best = min(order.index(ids.index(gold)) + 1 for gold in item["gold"])
        top1 += best == 1
        top3 += best <= 3
        reciprocal += 1 / best
        if best > 3:
            misses.append(f"{item['q']!r} -> {ids[order[0]]}")
    n = len(questions)
    return {
        "model": name,
        "prefix": bool(query_prefix),
        "r1": top1 / n,
        "r3": top3 / n,
        "mrr": reciprocal / n,
        "ms": (time.monotonic() - started) / n * 1000,
        "misses": misses,
    }


def main() -> None:
    import os

    data = json.load(sys.stdin)
    cache = os.getenv("FASTEMBED_CACHE_PATH", "/models/fastembed")
    print(f"{len(data['questions'])} questions over {len(data['passages'])} passages\n")
    print(f"{'model':42} {'prefix':6} {'R@1':>5} {'R@3':>5} {'MRR':>5} {'ms/q':>5}")
    for name, query_prefix, passage_prefix in CANDIDATES:
        r = evaluate(data, name, query_prefix, passage_prefix, cache)
        print(f"{r['model']:42} {'yes' if r['prefix'] else 'no':6} {r['r1']:5.2f} {r['r3']:5.2f} {r['mrr']:5.2f} {r['ms']:5.0f}")
        for miss in r["misses"]:
            print(f"    missed {miss}")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
