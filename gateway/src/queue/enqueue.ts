import { Redis } from "ioredis";
import { QUEUES, TASK_ENHANCE, type EnhanceTaskPayload } from "@rmcollab/shared";
import { sendTask } from "./celery.js";

// Dedicated producer connection: the pub/sub and stream-consumer clients are in
// subscriber mode or blocking on reads, and neither can issue ordinary commands.
let producer: Redis | null = null;

function client(): Redis {
  if (!producer) {
    producer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379/0", {
      maxRetriesPerRequest: null,
    });
  }
  return producer;
}

/** `queue` comes from capability routing; the media type's queue is the fallback. */
export async function enqueueEnhanceTask(payload: EnhanceTaskPayload, queue?: string): Promise<string> {
  return sendTask(client(), {
    taskName: TASK_ENHANCE,
    queue: queue ?? QUEUES[payload.media_type],
    kwargs: payload as unknown as Record<string, unknown>,
  });
}

export async function closeQueue(): Promise<void> {
  if (producer) {
    await producer.quit();
    producer = null;
  }
}
