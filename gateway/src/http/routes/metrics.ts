import { QUEUES, type MediaType } from "@rmcollab/shared";
import { Router } from "express";
import { Redis } from "ioredis";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { asyncHandler } from "../asyncHandler.js";

// Celery's Redis transport stores a queue as a plain list keyed by queue name,
// so depth is just LLEN — the same fact the workers BRPOP against.
const STRATEGY_PREFIX = "rmcollab:strategies";

let client: Redis | null = null;
function redis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    client.on("error", (err) => console.error("[metrics]", err.message));
  }
  return client;
}

export async function closeMetrics(): Promise<void> {
  if (client) {
    await client.quit();
    client = null;
  }
}

interface QueueDepth {
  mediaType: MediaType;
  queue: string;
  depth: number;
  /** Media types advertised by at least one live worker heartbeat. */
  workersOnline: boolean;
}

async function queueDepths(): Promise<QueueDepth[]> {
  const entries = Object.entries(QUEUES) as [MediaType, string][];
  const pipeline = redis().pipeline();
  for (const [, queue] of entries) pipeline.llen(queue);
  const results = await pipeline.exec();

  const online = new Set<string>();
  let cursor = "0";
  do {
    const [next, keys] = await redis().scan(cursor, "MATCH", `${STRATEGY_PREFIX}:*`, "COUNT", 100);
    cursor = next;
    // rmcollab:strategies:<mediaType>:<name>
    for (const key of keys) {
      const part = key.split(":")[2];
      if (part) online.add(part);
    }
  } while (cursor !== "0");

  return entries.map(([mediaType, queue], index) => ({
    mediaType,
    queue,
    depth: Number(results?.[index]?.[1] ?? 0),
    workersOnline: online.has(mediaType),
  }));
}

export const metricsRouter = Router();

metricsRouter.get(
  "/api/metrics",
  asyncHandler(async (_req, res) => {
    const [queues, jobs, stream] = await Promise.all([
      queueDepths(),
      pool.query<{ status: string; count: string }>(
        `SELECT status, COUNT(*)::text AS count FROM enhancement_jobs GROUP BY status`,
      ),
      redis().xlen("rmcollab:job-events"),
    ]);

    const byStatus: Record<string, number> = { queued: 0, processing: 0, done: 0, failed: 0 };
    for (const row of jobs.rows) byStatus[row.status] = Number(row.count);

    res.json({
      // Which replica answered: with several behind the load balancer, refreshing
      // shows the id change, which is the point of the whole exercise.
      replicaId: config.replicaId,
      queues,
      jobs: byStatus,
      jobEventStreamLength: stream,
      at: Date.now(),
    });
  }),
);
