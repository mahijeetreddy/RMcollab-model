from __future__ import annotations

import json

import pytest
import redis

from workers.common import events as ev
from workers.common.contracts import EnhanceTaskPayload, JobEventArtifact


class FakeRedis:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list[dict] = []
        self.fail = fail

    def xadd(self, stream, fields, maxlen=None, approximate=None):
        if self.fail:
            raise redis.ConnectionError("broker down")
        self.sent.append(json.loads(fields["payload"]))


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock(monkeypatch) -> Clock:
    c = Clock()
    monkeypatch.setattr(ev.time, "monotonic", c)
    return c


@pytest.fixture
def payload() -> EnhanceTaskPayload:
    return EnhanceTaskPayload(
        job_id="j1",
        media_item_id="m1",
        room_id="r1",
        session_id="s1",
        media_type="video",
        strategy="classical",
        input_path="rooms/r1/m1/original.mp4",
        output_path="rooms/r1/m1/enhanced.mp4",
    )


def emitter(payload, client) -> ev.JobEventEmitter:
    return ev.JobEventEmitter(payload, client=client)


class TestThrottling:
    def test_a_per_frame_burst_is_capped(self, payload, clock):
        # 60 frames reported inside a quarter second must not become 60 events.
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.processing("start")
        for i in range(1, 61):
            clock.now += 0.004
            e.progress(i / 1000)
        assert [x["status"] for x in fake.sent] == ["processing"]

    def test_a_large_jump_is_reported_immediately(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.processing("start")
        clock.now += 0.01
        e.progress(0.5)
        assert [x["progress"] for x in fake.sent] == [0.0, 0.5]

    def test_a_small_step_is_reported_once_the_interval_passes(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.processing("start")
        clock.now += ev.MIN_PROGRESS_INTERVAL_S + 0.01
        e.progress(0.05)
        assert fake.sent[-1]["progress"] == 0.05

    def test_force_bypasses_the_throttle(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.processing("start")
        e.progress(0.01, force=True)
        assert len(fake.sent) == 2

    def test_progress_is_clamped_to_zero_and_one(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.progress(7.0, force=True)
        e.progress(-3.0, force=True)
        assert [x["progress"] for x in fake.sent] == [1.0, 0.0]


class TestLifecycleEventsAreNeverThrottled:
    def test_done_is_sent_immediately_after_progress(self, payload, clock):
        # A throttled terminal event would leave the UI stuck on "processing".
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.processing("start")
        e.progress(0.9, force=True)
        art = JobEventArtifact(kind="enhanced", label="Enhanced", path="rooms/r1/m1/enhanced.mp4")
        e.done([art], "finished")
        last = fake.sent[-1]
        assert last["status"] == "done"
        assert last["progress"] == 1.0
        assert last["artifacts"][0]["path"] == "rooms/r1/m1/enhanced.mp4"

    def test_failed_carries_a_bounded_error(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.failed("x" * (ev.MAX_ERROR_CHARS * 3))
        last = fake.sent[-1]
        assert last["status"] == "failed"
        assert len(last["error"]) == ev.MAX_ERROR_CHARS

    def test_failed_keeps_the_last_reported_progress(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.progress(0.6, force=True)
        e.failed("boom")
        assert fake.sent[-1]["progress"] == 0.6


class TestBrokerFailures:
    def test_a_broker_outage_never_raises_into_the_job(self, payload, clock):
        # Losing an event is recoverable; turning a finished job into a failed
        # one because Redis blinked is not.
        e = emitter(payload, FakeRedis(fail=True))
        e.processing("start")
        e.progress(0.5, force=True)
        e.done([JobEventArtifact(kind="enhanced", label="E", path="p")])
        e.failed("still no exception")

    def test_the_strategy_that_actually_ran_is_reported(self, payload, clock):
        fake = FakeRedis()
        e = emitter(payload, fake)
        e.strategy = "fallback-strategy"
        e.processing("start")
        assert fake.sent[-1]["strategy"] == "fallback-strategy"
