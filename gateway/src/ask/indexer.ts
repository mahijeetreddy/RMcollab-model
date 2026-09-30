import {
  EMBEDDING_STREAM,
  QUEUE_EMBED,
  TASK_EMBED_PASSAGES,
  type EmbeddingResult,
  type EmbedPassagesTask,
} from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { enqueueTask } from "../queue/enqueue.js";
import { decodeVector, splitPending, storeEmbeddings, unembedded, type PassageText } from "./store.js";

/**
 * Keeps every searchable document split into passages with embeddings: new
 * documents as their jobs finish, older ones once at boot, and vectors stored
 * as the worker sends them back.
 */

/** Passages a single embedding task carries: a fraction of a second of work, so a question never waits long behind one. */
const BATCH = 32;
const GROUP = "gateway";
const BLOCK_MS = 5000;
/** Only one replica backfills at a time; another may retry after this. */
const BACKFILL_LOCK_S = 600;

async function enqueueEmbeddings(passages: PassageText[]): Promise<void> {
  for (let i = 0; i < passages.length; i += BATCH) {
    const task: EmbedPassagesTask = { items: passages.slice(i, i + BATCH) };
    await enqueueTask(TASK_EMBED_PASSAGES, QUEUE_EMBED, task as unknown as Record<string, unknown>);
  }
}

/** Splits and queues a finished job's documents. */
export async function indexJob(jobId: string): Promise<number> {
  const passages = await splitPending({ jobId, limit: 20 });
  await enqueueEmbeddings(passages);
  return passages.length;
}

/**
 * Splits documents from before Ask existed, and re-queues passages whose
 * embedding never arrived (a worker that was down, a restart mid-batch). One
 * replica at a time, under a lock; repeating it is harmless either way.
 */
export async function backfillPassages(redis: Redis): Promise<{ split: number; queued: number }> {
  const lock = await redis.set("rmcollab:ask:backfill-lock", config.replicaId, "EX", BACKFILL_LOCK_S, "NX");
  if (lock !== "OK") return { split: 0, queued: 0 };
  let split = 0;
  for (;;) {
    const passages = await splitPending({ limit: 50 });
    // splitPending marks what it read, so an empty batch means nothing is left.
    if (passages.length === 0 && !(await hasUnsplit())) break;
    await enqueueEmbeddings(passages);
    split += passages.length;
  }
  // Passages from before this boot that still have no vector. Newer ones are
  // left alone: their embedding is most likely in flight.
  const stale = await unembedded(5000, 60_000);
  await enqueueEmbeddings(stale);
  return { split, queued: stale.length };
}

async function hasUnsplit(): Promise<boolean> {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM job_artifacts WHERE passages_at IS NULL AND body IS NOT NULL LIMIT 1`,
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Stores the vectors workers send back. One consumer group across replicas, so
 * each batch is written once; a redelivered batch writes the same values again.
 */
export class EmbeddingConsumer {
  private readonly redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  private running = false;

  constructor() {
    this.redis.on("error", (err) => console.error("[ask] embeddings redis", err.message));
  }

  async start(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", EMBEDDING_STREAM, GROUP, "0", "MKSTREAM");
    } catch (err) {
      if (!(err instanceof Error && err.message.includes("BUSYGROUP"))) throw err;
    }
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const response = (await this.redis.xreadgroup(
          "GROUP",
          GROUP,
          config.replicaId,
          "COUNT",
          16,
          "BLOCK",
          BLOCK_MS,
          "STREAMS",
          EMBEDDING_STREAM,
          ">",
        )) as [string, [string, string[]][]][] | null;
        if (!response) continue;
        for (const [, entries] of response) {
          for (const [entryId, fields] of entries) {
            try {
              await this.handle(fields);
            } catch (err) {
              console.error("[ask] embedding batch failed", entryId, err);
            }
            await this.redis.xack(EMBEDDING_STREAM, GROUP, entryId);
          }
        }
      } catch (err) {
        if (!this.running) return;
        console.error("[ask] embeddings read failed", err);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  }

  private async handle(fields: string[]): Promise<void> {
    const raw = fields[fields.indexOf("payload") + 1];
    if (!raw) return;
    const result = JSON.parse(raw) as EmbeddingResult;
    await storeEmbeddings(result.vectors.map((v) => ({ id: v.id, vector: decodeVector(v.vector) })));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.redis.disconnect();
  }
}

export const embeddingConsumer = new EmbeddingConsumer();
