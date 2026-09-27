import { describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { __testing, sendTask } from "../src/queue/celery.js";

const { buildEnvelope } = __testing;

const EMBED = { callbacks: null, errbacks: null, chain: null, chord: null };

const decodeBody = (body: string): unknown =>
  JSON.parse(Buffer.from(body, "base64").toString("utf-8"));

describe("Celery protocol v2 envelope", () => {
  const args = ["room-1", { id: "m1" }];
  const kwargs = { scale: 2 };
  const { envelope, taskId } = buildEnvelope({
    taskName: "workers.enhance",
    queue: "gpu",
    args,
    kwargs,
  });

  it("encodes body as base64 JSON [args, kwargs, embed]", () => {
    const decoded = decodeBody(envelope.body);
    // Protocol v2 is identified by this exact three-element shape; a v1 body is a dict and gets rejected.
    expect(Array.isArray(decoded)).toBe(true);
    expect(decoded).toHaveLength(3);
    expect(decoded).toEqual([args, kwargs, EMBED]);
  });

  it("defaults args and kwargs to empty containers", () => {
    const { envelope: bare } = buildEnvelope({ taskName: "t", queue: "q" });
    expect(decodeBody(bare.body)).toEqual([[], {}, EMBED]);
  });

  it("declares the content type and encodings Kombu expects", () => {
    expect(envelope["content-type"]).toBe("application/json");
    expect(envelope["content-encoding"]).toBe("utf-8");
    expect(envelope.properties.body_encoding).toBe("base64");
  });

  it("ties task id, root id and correlation id to the returned id", () => {
    expect(envelope.headers.task).toBe("workers.enhance");
    expect(envelope.headers.id).toBe(taskId);
    expect(envelope.headers.root_id).toBe(taskId);
    expect(envelope.properties.correlation_id).toBe(taskId);
  });

  it("routes to the queue and carries a delivery tag", () => {
    expect(envelope.properties.delivery_info).toEqual({ exchange: "", routing_key: "gpu" });
    expect(typeof envelope.properties.delivery_tag).toBe("string");
    expect(envelope.properties.delivery_tag).not.toBe("");
  });

  it("generates a unique task id per call", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => buildEnvelope({ taskName: "t", queue: "q" }).taskId),
    );
    expect(ids.size).toBe(50);
  });
});

describe("sendTask", () => {
  it("LPUSHes a JSON envelope onto the bare queue name and returns the task id", async () => {
    const calls: [string, string][] = [];
    const fakeRedis = {
      lpush: async (key: string, value: string) => {
        calls.push([key, value]);
        return 1;
      },
    } as unknown as Redis;

    const taskId = await sendTask(fakeRedis, {
      taskName: "workers.enhance",
      queue: "gpu",
      args: [1],
    });

    expect(calls).toHaveLength(1);
    const [key, value] = calls[0]!;
    // Kombu's Redis transport BRPOPs from exactly the queue name, with no prefix.
    expect(key).toBe("gpu");
    expect(typeof value).toBe("string");
    const sent = JSON.parse(value);
    expect(sent.headers.id).toBe(taskId);
    expect(sent.headers.task).toBe("workers.enhance");
    expect(decodeBody(sent.body)).toEqual([[1], {}, EMBED]);
  });
});
