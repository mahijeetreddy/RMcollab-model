from __future__ import annotations

import json
from pathlib import Path

import pytest

from workers.common.config import Config, StoragePathError
from workers.common.contracts import JobEvent, JobEventArtifact


def event(**overrides) -> JobEvent:
    base = dict(
        jobId="j1",
        mediaItemId="m1",
        roomId="r1",
        sessionId="s1",
        mediaType="audio",
        strategy="transcribe",
        status="done",
        progress=1.0,
    )
    base.update(overrides)
    return JobEvent(**base)


def decode(evt: JobEvent) -> dict:
    fields = evt.to_stream_fields()
    assert set(fields) == {"payload"}
    return json.loads(fields["payload"])


class TestJobEventWireFormat:
    def test_keys_are_camel_case_on_the_wire(self):
        payload = decode(event())
        assert {"jobId", "mediaItemId", "roomId", "sessionId", "mediaType"} <= payload.keys()

    def test_none_fields_are_omitted_rather_than_sent_as_null(self):
        payload = decode(event(message=None, error=None))
        assert "message" not in payload
        assert "error" not in payload

    def test_nulls_inside_artifacts_are_pruned_too(self):
        # The TypeScript side types these as optional (`string | undefined`), so
        # a JSON null would fail the client's validators rather than read as absent.
        art = JobEventArtifact(kind="transcript", label="Transcript", path="rooms/r/m/t.txt")
        payload = decode(event(artifacts=[art]))
        (sent,) = payload["artifacts"]
        assert "mimeType" not in sent
        assert sent == {"kind": "transcript", "label": "Transcript", "path": "rooms/r/m/t.txt", "meta": {}}

    def test_emitted_at_is_stamped_in_milliseconds(self):
        payload = decode(event())
        assert payload["emittedAt"] > 1_600_000_000_000


class TestStoragePathGuard:
    """Task payloads carry paths chosen by the gateway, but the worker must still
    refuse anything that escapes STORAGE_ROOT - it writes files to these paths."""

    @pytest.fixture
    def config(self, tmp_path: Path) -> Config:
        return Config(
            redis_url="redis://unused",
            storage_root=tmp_path,
            celery_queues=("enhance.text",),
            celery_concurrency=1,
        )

    def test_resolves_a_normal_relative_path_inside_the_root(self, config, tmp_path):
        assert config.resolve("rooms/r1/m1/original.txt") == (tmp_path / "rooms/r1/m1/original.txt").resolve()

    @pytest.mark.parametrize("escape", ["../outside.txt", "rooms/../../outside.txt", "rooms/../../../etc/passwd"])
    def test_rejects_traversal(self, config, escape):
        with pytest.raises(StoragePathError):
            config.resolve(escape)

    def test_rejects_an_absolute_path(self, config, tmp_path):
        outside = (tmp_path.parent / "elsewhere.txt").resolve()
        with pytest.raises(StoragePathError):
            config.resolve(str(outside))

    def test_relativize_round_trips(self, config, tmp_path):
        absolute = config.resolve("rooms/r1/m1/enhanced.png")
        assert config.relativize(absolute) == "rooms/r1/m1/enhanced.png"

    def test_relativize_refuses_a_path_outside_the_root(self, config, tmp_path):
        with pytest.raises(StoragePathError):
            config.relativize(tmp_path.parent / "elsewhere.png")

    def test_media_types_derive_from_queue_names(self, tmp_path):
        cfg = Config("redis://x", tmp_path, ("enhance.audio", "enhance.text", "not.a.queue"), 1)
        assert cfg.media_types == ("audio", "text")
