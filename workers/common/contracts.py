"""Wire contracts shared with the gateway. Mirrors shared/src/events.ts —
change both together."""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

MediaType = Literal["text", "image", "audio", "video"]
JobStatus = Literal["queued", "processing", "done", "failed"]

TASK_ENHANCE = "rmcollab.enhance"

QUEUES: dict[str, str] = {
    "text": "enhance.text",
    "image": "enhance.image",
    "audio": "enhance.audio",
    "video": "enhance.video",
}

JOB_EVENT_STREAM = "rmcollab:job-events"


@dataclass
class EnhanceTaskPayload:
    job_id: str
    media_item_id: str
    room_id: str
    session_id: str
    media_type: MediaType
    strategy: str
    input_path: str
    output_path: str
    params: dict[str, Any] = field(default_factory=dict)


ArtifactKind = Literal["enhanced", "transcript", "summary"]


@dataclass
class JobEventArtifact:
    kind: ArtifactKind
    label: str
    #: Storage-relative. The gateway signs it when serving; workers never mint URLs.
    path: str
    mimeType: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass
class JobEvent:
    jobId: str
    mediaItemId: str
    roomId: str
    sessionId: str
    mediaType: MediaType
    strategy: str
    status: JobStatus
    progress: float
    message: str | None = None
    artifacts: list[JobEventArtifact] | None = None
    error: str | None = None
    emittedAt: int = 0

    def to_stream_fields(self) -> dict[str, str]:
        # Nulls are stripped at every level, not just the top: the TypeScript side
        # declares these fields optional (`string | undefined`), so a JSON `null`
        # would be rejected by the client's guards rather than treated as absent.
        def prune(value: Any) -> Any:
            if isinstance(value, dict):
                return {k: prune(v) for k, v in value.items() if v is not None}
            if isinstance(value, list):
                return [prune(v) for v in value]
            return value

        data = prune(asdict(self))
        data["emittedAt"] = int(time.time() * 1000)
        return {"payload": json.dumps(data)}


# One strategy a pool can run, published to Redis for the gateway. `queue` is
# where a job must be sent to reach this pool, which is not always the queue
# named after the media type: see advertise.serving_queue. snake_case on the
# wire, like EnhanceTaskPayload, because Python writes it.
@dataclass(frozen=True)
class StrategyAdvert:
    name: str
    label: str
    description: str
    media_type: MediaType
    is_default: bool
    available: bool
    unavailable_reason: str
    explicit_default: bool
    queue: str


# --- Ask the room ------------------------------------------------------------
# Mirrors the "Ask the room" block of shared/src/events.ts. The worker embeds
# (questions, notes sections, document passages) and writes answers; it never
# reads the database - the gateway retrieves and sends the passages in.

TASK_EMBED_PASSAGES = "rmcollab.embed_passages"
TASK_ASK_PREPARE = "rmcollab.ask_prepare"
TASK_ASK_ANSWER = "rmcollab.ask_answer"
QUEUE_ASK = "ask"
QUEUE_EMBED = "embed"
EMBEDDING_STREAM = "rmcollab:embeddings"
ASK_CHANNEL_PREFIX = "rmcollab:ask:"
EMBEDDING_MODEL = "snowflake/snowflake-arctic-embed-m"
EMBEDDING_DIMENSIONS = 768

AskReplyType = Literal["vectors", "delta", "done", "error"]


def ask_channel(request_id: str) -> str:
    return f"{ASK_CHANNEL_PREFIX}{request_id}"


@dataclass(frozen=True)
class EmbedItem:
    id: str
    text: str


@dataclass(frozen=True)
class EmbedPassagesTask:
    items: list[EmbedItem]


@dataclass(frozen=True)
class EmbeddedVector:
    id: str
    vector: str


@dataclass(frozen=True)
class EmbeddingResult:
    model: str
    vectors: list[EmbeddedVector]


@dataclass(frozen=True)
class AskHistoryTurn:
    question: str
    answer: str


@dataclass(frozen=True)
class AskPrepareTask:
    request_id: str
    question: str
    notes: list[EmbedItem]
    history: list[AskHistoryTurn]


@dataclass(frozen=True)
class AskPassage:
    n: int
    source: str
    text: str


@dataclass(frozen=True)
class AskAnswerTask:
    request_id: str
    question: str
    passages: list[AskPassage]


@dataclass(frozen=True)
class AskReply:
    type: AskReplyType
    question: str | None = None
    standalone: str | None = None
    notes: list[EmbeddedVector] | None = None
    text: str | None = None
    model: str | None = None
    code: str | None = None
    message: str | None = None

    def to_json(self) -> str:
        # Absent, not null, for the optional fields: the gateway reads them as
        # `string | undefined`.
        return json.dumps({k: v for k, v in asdict(self).items() if v is not None})
