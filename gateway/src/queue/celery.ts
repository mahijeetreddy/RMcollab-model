import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

// Celery protocol v2 producer.
//
// There is no maintained Node Celery client (celery-node was last published in
// 2022), so the gateway speaks the wire protocol directly. Kombu's Redis
// transport is simple: a task message is a JSON envelope LPUSH'd onto a list
// named after the queue, which workers drain with BRPOP. The envelope's `body`
// is base64(JSON([args, kwargs, embed])) — the three-element shape is what
// makes it protocol v2 rather than v1, and Celery will reject it otherwise.
//
// Reference: https://docs.celeryq.dev/en/stable/internals/protocol.html

interface TaskOptions {
  taskName: string;
  queue: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  origin?: string;
}

interface CeleryEnvelope {
  body: string;
  "content-encoding": "utf-8";
  "content-type": "application/json";
  headers: Record<string, unknown>;
  properties: Record<string, unknown>;
}

function buildEnvelope({
  taskName,
  queue,
  args = [],
  kwargs = {},
  origin = "gateway@rmcollab",
}: TaskOptions): { envelope: CeleryEnvelope; taskId: string } {
  const taskId = randomUUID();

  // The trailing object carries chain/chord wiring we don't use, but Celery
  // expects the slot to be present.
  const embed = { callbacks: null, errbacks: null, chain: null, chord: null };
  const body = Buffer.from(JSON.stringify([args, kwargs, embed]), "utf-8").toString("base64");

  const envelope: CeleryEnvelope = {
    body,
    "content-encoding": "utf-8",
    "content-type": "application/json",
    headers: {
      lang: "py",
      task: taskName,
      id: taskId,
      root_id: taskId,
      parent_id: null,
      group: null,
      group_index: null,
      shadow: null,
      eta: null,
      expires: null,
      retries: 0,
      timelimit: [null, null],
      argsrepr: JSON.stringify(args),
      kwargsrepr: JSON.stringify(kwargs),
      origin,
      ignore_result: false,
    },
    properties: {
      correlation_id: taskId,
      reply_to: randomUUID(),
      delivery_mode: 2,
      delivery_info: { exchange: "", routing_key: queue },
      priority: 0,
      body_encoding: "base64",
      delivery_tag: randomUUID(),
    },
  };

  return { envelope, taskId };
}

/** Publishes a task to a Celery queue. Resolves with the Celery task id. */
export async function sendTask(redis: Redis, options: TaskOptions): Promise<string> {
  const { envelope, taskId } = buildEnvelope(options);
  await redis.lpush(options.queue, JSON.stringify(envelope));
  return taskId;
}

export const __testing = { buildEnvelope };
