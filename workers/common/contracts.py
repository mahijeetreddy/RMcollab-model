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
