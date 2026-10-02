import { describe, expect, it } from "vitest";
import { positionsIn, type QueuedJob } from "../src/http/routes/queue.js";

const job = (o: Partial<QueuedJob> & Pick<QueuedJob, "id" | "roomId" | "sessionId" | "createdAt">): QueuedJob => ({
  queue: "enhance.audio",
  status: "queued",
  dispatchedAt: null,
  ...o,
});

describe("positionsIn", () => {
  it("counts jobs already handed to the pool first, then the fair order of the rest", () => {
    const jobs = [
      // Another session's backlog: one sent to the pool, two waiting.
      job({ id: "other-sent", roomId: "x", sessionId: "X", createdAt: 1, dispatchedAt: 10 }),
      job({ id: "other-2", roomId: "x", sessionId: "X", createdAt: 2 }),
      job({ id: "other-3", roomId: "x", sessionId: "X", createdAt: 3 }),
      // Ours arrived last, but its session has nothing running: next after the sent one.
      job({ id: "mine", roomId: "room", sessionId: "S", createdAt: 4 }),
    ];
    expect(positionsIn(jobs, "room")).toEqual({ mine: 1 });
  });

  it("keeps each pool's line separate, and does not count running jobs as ahead", () => {
    const jobs = [
      job({ id: "running", roomId: "x", sessionId: "X", createdAt: 1, status: "processing", dispatchedAt: 1 }),
      job({ id: "image", roomId: "x", sessionId: "X", createdAt: 2, queue: "enhance.image" }),
      job({ id: "mine", roomId: "room", sessionId: "S", createdAt: 3 }),
    ];
    expect(positionsIn(jobs, "room")).toEqual({ mine: 0 });
  });
});
