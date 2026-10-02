import type { EnhanceTaskPayload } from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { enqueueEnhanceTask } from "./enqueue.js";
import { fairOrder } from "./fair.js";

/**
 * Hands jobs to the worker pools a few at a time, in fair order (fair.ts).
 *
 * Before, every upload went straight onto its pool's Redis queue, and a Celery
 * queue is first in, first out. Now a job waits in Postgres (its payload and
 * queue stored with it) and this keeps each pool's broker queue topped up to
 * DISPATCH_AHEAD - enough that a worker finishing one job always has the next
 * ready, few enough that the order is still decided here when a new session's
 * job arrives. One replica dispatches at a time, under a transaction-scoped
 * advisory lock; the rows are claimed with FOR UPDATE SKIP LOCKED besides.
 *
 * A job is marked dispatched only after Redis took it, in the same
 * transaction: a crash in between can send a job twice (its events are
 * idempotent), never lose one.
 */

const DISPATCH_LOCK = 0x524d_6471; // "RMdq"
const TICK_MS = 1000;
/** Waiting jobs looked at per pool per tick. */
const WINDOW = 2000;

let redis: Redis | null = null;
function client(): Redis {
  redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

/** Stores what a job needs to be sent, and asks for a dispatch. */
export async function submitJob(jobId: string, payload: EnhanceTaskPayload, queue: string): Promise<void> {
  await pool.query(`UPDATE enhancement_jobs SET queue = $2, payload = $3 WHERE id = $1`, [jobId, queue, payload]);
  kick();
}

export async function dispatchOnce(): Promise<number> {
  const db = await pool.connect();
  let sent = 0;
  try {
    await db.query("BEGIN");
    const { rows: lock } = await db.query<{ ok: boolean }>(`SELECT pg_try_advisory_xact_lock($1) AS ok`, [DISPATCH_LOCK]);
    if (!lock[0]?.ok) {
      await db.query("ROLLBACK");
      return 0;
    }
    const { rows: queues } = await db.query<{ queue: string }>(
      `SELECT DISTINCT queue FROM enhancement_jobs
       WHERE status = 'queued' AND dispatched_at IS NULL AND payload IS NOT NULL`,
    );
    for (const { queue } of queues) {
      const free = config.dispatchAhead - (await client().llen(queue));
      if (free <= 0) continue;
      const { rows: waiting } = await db.query<{ id: string; session_id: string; created_at: number; payload: EnhanceTaskPayload }>(
        `SELECT j.id, r.session_id, j.created_at, j.payload
         FROM enhancement_jobs j
         JOIN media_items m ON m.id = j.media_item_id
         JOIN rooms r ON r.id = m.room_id
         WHERE j.queue = $1 AND j.status = 'queued' AND j.dispatched_at IS NULL AND j.payload IS NOT NULL
         ORDER BY j.created_at
         LIMIT ${WINDOW}
         FOR UPDATE OF j SKIP LOCKED`,
        [queue],
      );
      const inFlight = await inFlightBySession(db, queue);
      const lastServed = await lastServedBySession(db, queue);
      const next = fairOrder(
        waiting.map((w) => ({ ...w, sessionId: w.session_id, createdAt: Number(w.created_at) })),
        inFlight,
        lastServed,
      ).slice(0, free);
      for (const job of next) {
        await enqueueEnhanceTask(job.payload, queue);
        await db.query(`UPDATE enhancement_jobs SET dispatched_at = $2 WHERE id = $1`, [job.id, dispatchStamp()]);
        sent += 1;
      }
    }
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    db.release();
  }
  return sent;
}

/** Per session: the jobs a pool already has - sent and waiting in Redis, or running. */
export async function inFlightBySession(
  db: { query: typeof pool.query },
  queue: string,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ session_id: string; n: string }>(
    `SELECT r.session_id, count(*) AS n
     FROM enhancement_jobs j
     JOIN media_items m ON m.id = j.media_item_id
     JOIN rooms r ON r.id = m.room_id
     WHERE j.queue = $1 AND j.dispatched_at IS NOT NULL AND j.status IN ('queued', 'processing')
     GROUP BY r.session_id`,
    [queue],
  );
  return new Map(rows.map((r) => [r.session_id, Number(r.n)]));
}

/**
 * When a job was handed over, strictly increasing: several go in one tick,
 * often within a millisecond, and the order they went in is what the queue
 * view shows - equal stamps would let the tie fall back to arrival order.
 */
let lastStamp = 0;
function dispatchStamp(): number {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

/** Per session: when this pool was last handed one of its jobs (the past day is plenty). */
export async function lastServedBySession(
  db: { query: typeof pool.query },
  queue: string,
): Promise<Map<string, number>> {
  const { rows } = await db.query<{ session_id: string; at: string }>(
    `SELECT r.session_id, max(j.dispatched_at) AS at
     FROM enhancement_jobs j
     JOIN media_items m ON m.id = j.media_item_id
     JOIN rooms r ON r.id = m.room_id
     WHERE j.queue = $1 AND j.dispatched_at > $2
     GROUP BY r.session_id`,
    [queue, Date.now() - 24 * 60 * 60 * 1000],
  );
  return new Map(rows.map((r) => [r.session_id, Number(r.at)]));
}

// --- the loop ----------------------------------------------------------------------

let timer: NodeJS.Timeout | null = null;
let running = false;
let again = false;

/** A dispatch soon: on a new job, and every tick (a pool finishing frees a slot). */
export function kick(): void {
  if (running) {
    again = true;
    return;
  }
  running = true;
  void dispatchOnce()
    .catch((err: unknown) => console.error("[dispatch] failed", err))
    .finally(() => {
      running = false;
      if (again) {
        again = false;
        kick();
      }
    });
}

export function startDispatcher(): void {
  if (timer) return;
  timer = setInterval(kick, TICK_MS);
  timer.unref();
  kick();
}

export async function stopDispatcher(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  if (redis) await redis.quit().catch(() => undefined);
  redis = null;
}
