import type { Artifact, JobEvent, ServerEvent } from "@rmcollab/shared";
import { JOB_EVENT_STREAM } from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { updateJobFromEvent } from "../db/repositories.js";
import { pubsub } from "../ws/pubsub.js";

const GROUP = "gateway";
const BLOCK_MS = 5000;

function toServerEvent(event: JobEvent, artifacts: Artifact[]): ServerEvent {
  if (event.status === "done" || event.status === "failed") {
    return {
      type: "job_complete",
      roomId: event.roomId,
      jobId: event.jobId,
      mediaItemId: event.mediaItemId,
      status: event.status,
      artifacts,
      ...(event.error ? { error: event.error } : {}),
    };
  }
  return {
    type: "job_status_update",
    roomId: event.roomId,
    jobId: event.jobId,
    mediaItemId: event.mediaItemId,
    status: event.status,
    progress: event.progress,
    ...(event.message ? { message: event.message } : {}),
  };
}

export class JobEventConsumer {
  private readonly redis: Redis;
  private readonly consumerName = config.replicaId;
  private running = false;

  constructor() {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.redis.on("error", (err) => console.error("[jobs] redis", err.message));
  }

  async start(): Promise<void> {
    // Every replica joins one consumer group, so each job event is handled
    // (persisted + fanned out) exactly once cluster-wide rather than per replica.
    try {
      await this.redis.xgroup("CREATE", JOB_EVENT_STREAM, GROUP, "$", "MKSTREAM");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BUSYGROUP")) throw err;
    }
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const response = await this.redis.xreadgroup(
          "GROUP",
          GROUP,
          this.consumerName,
          "COUNT",
          32,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          JOB_EVENT_STREAM,
          ">",
        );
        if (!response) continue;

        for (const stream of response as [string, [string, string[]][]][]) {
          for (const [entryId, fields] of stream[1]) {
            try {
              await this.handleEntry(fields);
            } catch (err) {
              console.error("[jobs] entry failed", entryId, err);
            }
            await this.redis.xack(JOB_EVENT_STREAM, GROUP, entryId);
          }
        }
      } catch (err) {
        if (!this.running) return;
        console.error("[jobs] read failed", err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handleEntry(fields: string[]): Promise<void> {
    const index = fields.indexOf("payload");
    const raw = index >= 0 ? fields[index + 1] : undefined;
    if (!raw) return;

    const event = JSON.parse(raw) as JobEvent;
    if (!event?.jobId || !event.roomId || !event.status) return;

    // null means unknown or already terminal — a redelivered or out-of-order
    // entry that must not regress clients past a finished job.
    const job = await updateJobFromEvent(event);
    if (!job) return;

    await pubsub.publishToRoom(event.roomId, toServerEvent(event, job.artifacts));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.redis.disconnect();
  }
}

export const jobEventConsumer = new JobEventConsumer();
