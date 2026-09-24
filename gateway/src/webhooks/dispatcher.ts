import type { JobEvent, WebhookEventPayload, WebhookEventType } from "@rmcollab/shared";
import { JOB_EVENT_STREAM } from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { migrate } from "../db/migrate.js";
import { pool } from "../db/pool.js";
import { createWebhookDelivery, listActiveWebhookEndpoints } from "../db/repositories.js";
import { attemptDelivery } from "./delivery.js";
import { claimDueDeliveries, closeWebhookQueue, pendingRetryCount, scheduleDelivery } from "./queue.js";

// Its own consumer group on the shared job-event stream: the gateway group
// (WS fan-out) and this one each see every event independently.
const GROUP = "webhook-dispatcher";
const BLOCK_MS = 5000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

class WebhookDispatcher {
  private readonly redis: Redis;
  private readonly consumerName = config.replicaId;
  private readonly inFlight = new Set<string>();
  private running = false;

  constructor() {
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.redis.on("error", (err) => console.error("[webhooks] redis", err.message));
  }

  async start(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", JOB_EVENT_STREAM, GROUP, "$", "MKSTREAM");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("BUSYGROUP")) throw err;
    }
    this.running = true;
    void this.streamLoop();
    void this.deliveryLoop();
  }

  private async streamLoop(): Promise<void> {
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
              await this.handleEntry(entryId, fields);
            } catch (err) {
              console.error("[webhooks] entry failed", entryId, err);
            }
            await this.redis.xack(JOB_EVENT_STREAM, GROUP, entryId);
          }
        }
      } catch (err) {
        if (!this.running) return;
        console.error("[webhooks] read failed", err);
        await sleep(1000);
      }
    }
  }

  private async handleEntry(entryId: string, fields: string[]): Promise<void> {
    const index = fields.indexOf("payload");
    const raw = index >= 0 ? fields[index + 1] : undefined;
    if (!raw) return;

    const event = JSON.parse(raw) as JobEvent;
    if (!event?.jobId || !event.sessionId || !event.status) return;

    const endpoints = await listActiveWebhookEndpoints(event.sessionId);
    if (endpoints.length === 0) return;

    const payload: WebhookEventPayload = {
      // Derived from the stream entry id, so the same event keeps one id across
      // endpoints, retries and replays — receivers can dedupe on it.
      id: `evt_${entryId.replace(":", "-")}`,
      type: `job.${event.status}` as WebhookEventType,
      createdAt: Date.now(),
      data: event,
    };

    for (const endpoint of endpoints) {
      const delivery = await createWebhookDelivery({
        endpointId: endpoint.id,
        eventId: payload.id,
        eventType: payload.type,
        payload,
        dueAt: Date.now(),
      });
      await scheduleDelivery(delivery.id, Date.now());
    }
  }

  private async deliveryLoop(): Promise<void> {
    while (this.running) {
      try {
        const capacity = config.webhooks.concurrency - this.inFlight.size;
        const ids = await claimDueDeliveries(capacity);
        for (const id of ids) {
          this.inFlight.add(id);
          // Not awaited: one slow or dead endpoint must not hold up the others.
          void attemptDelivery(id)
            .catch((err: unknown) => console.error("[webhooks] delivery failed", id, err))
            .finally(() => this.inFlight.delete(id));
        }
      } catch (err) {
        if (!this.running) return;
        console.error("[webhooks] claim failed", err);
      }
      await sleep(config.webhooks.pollIntervalMs);
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.redis.disconnect();
  }
}

async function main(): Promise<void> {
  await migrate();

  const dispatcher = new WebhookDispatcher();
  await dispatcher.start();
  console.log(
    `[webhooks] dispatcher ${config.replicaId} started ` +
      `(concurrency=${config.webhooks.concurrency}, maxAttempts=${config.webhooks.maxAttempts}, ` +
      `allowPrivateUrls=${config.webhooks.allowPrivateUrls}, pending=${await pendingRetryCount()})`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[webhooks] ${signal} received, shutting down`);
    await dispatcher.stop();
    await closeWebhookQueue();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[webhooks] boot failed", err);
  process.exit(1);
});
