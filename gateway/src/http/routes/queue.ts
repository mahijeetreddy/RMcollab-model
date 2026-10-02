import type { MediaType } from "@rmcollab/shared";
import { Router } from "express";
import { pool } from "../../db/pool.js";
import { getParticipant, getRoom, hasRoomAccess } from "../../db/repositories.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";
import { lastServedBySession } from "../../queue/dispatcher.js";
import { fairOrder } from "../../queue/fair.js";
import { routeJob } from "./strategies.js";

/**
 * Where a room's waiting jobs are in line. The worker pools are shared by every
 * session, so on a busy or CPU-only host a job can wait behind other people's;
 * "3 ahead of it" says it is moving, where "Waiting for a worker" alone looks
 * stuck. Pools take turns between sessions (queue/fair.ts), and the count
 * follows that same order. Approximate by nature - a pool runs several at
 * once - and said so in the words shown.
 */
export const queueRouter = Router();

/** More than this many queued jobs, and the exact count stops mattering. */
const MAX_COUNTED = 5000;

export interface QueuedJob {
  id: string;
  roomId: string;
  sessionId: string;
  /** The worker pool's queue it is routed to. */
  queue: string;
  status: "queued" | "processing";
  createdAt: number;
  /** When the dispatcher handed it to its pool; null while it waits its turn. */
  dispatchedAt: number | null;
}

/**
 * For each queued job of `roomId`: how many jobs are ahead of it in its pool.
 * The same order the dispatcher works in (queue/fair.ts): jobs already handed
 * to the pool first, in the order they were, then everything still waiting in
 * fair order - so "3 ahead" is where the job really stands, not where it would
 * be in arrival order.
 */
export function positionsIn(
  jobs: QueuedJob[],
  roomId: string,
  /** Per queue, per session: when the pool was last handed one of its jobs. */
  lastServed: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map(),
): Record<string, number> {
  const positions: Record<string, number> = {};
  const byQueue = new Map<string, QueuedJob[]>();
  for (const job of jobs) byQueue.set(job.queue, [...(byQueue.get(job.queue) ?? []), job]);
  for (const [queue, inQueue] of byQueue) {
    const inFlight = new Map<string, number>();
    for (const job of inQueue) {
      if (job.status === "processing" || job.dispatchedAt !== null) {
        inFlight.set(job.sessionId, (inFlight.get(job.sessionId) ?? 0) + 1);
      }
    }
    const sent = inQueue
      .filter((j) => j.status === "queued" && j.dispatchedAt !== null)
      .sort((a, b) => a.dispatchedAt! - b.dispatchedAt! || a.createdAt - b.createdAt);
    const waiting = fairOrder(
      inQueue.filter((j) => j.status === "queued" && j.dispatchedAt === null),
      inFlight,
      lastServed.get(queue),
    );
    [...sent, ...waiting].forEach((job, index) => {
      if (job.roomId === roomId) positions[job.id] = index;
    });
  }
  return positions;
}

queueRouter.get(
  "/api/rooms/:roomId/queue",
  asyncHandler(async (req, res) => {
    const room = await getRoom(routeParam(req, "roomId"));
    const participantId = typeof req.query["participantId"] === "string" ? req.query["participantId"] : "";
    const participant = participantId ? await getParticipant(participantId) : null;
    if (!room || !participant || participant.sessionId !== room.sessionId || !(await hasRoomAccess(room.id, participant.id))) {
      res.status(403).json({ error: "not_in_room", message: "Join the room first." });
      return;
    }
    const { rows } = await pool.query<{
      id: string;
      room_id: string;
      session_id: string;
      queue: string | null;
      media_type: MediaType;
      strategy: string;
      status: "queued" | "processing";
      created_at: number;
      dispatched_at: number | null;
      payload_stored: boolean;
    }>(
      `SELECT j.id, m.room_id, r.session_id, j.queue, j.media_type, j.strategy, j.status, j.created_at,
              j.dispatched_at, j.payload IS NOT NULL AS payload_stored
       FROM enhancement_jobs j
       JOIN media_items m ON m.id = j.media_item_id
       JOIN rooms r ON r.id = m.room_id
       WHERE j.status IN ('queued', 'processing')
       ORDER BY j.created_at, j.id
       LIMIT ${MAX_COUNTED}`,
    );
    const jobs: QueuedJob[] = rows.map((r) => ({
      id: r.id,
      roomId: r.room_id,
      sessionId: r.session_id,
      // Jobs from before fair queueing were sent straight away and stored no queue.
      queue: r.queue ?? routeJob(r.media_type, r.strategy),
      status: r.status,
      createdAt: Number(r.created_at),
      dispatchedAt: r.dispatched_at !== null ? Number(r.dispatched_at) : r.payload_stored ? null : Number(r.created_at),
    }));
    const queues = [...new Set(jobs.map((j) => j.queue))];
    const lastServed = new Map(await Promise.all(queues.map(async (q) => [q, await lastServedBySession(pool, q)] as const)));
    res.json({ positions: positionsIn(jobs, room.id, lastServed) });
  }),
);
