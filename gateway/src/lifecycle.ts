import { config } from "./config.js";
import { pool } from "./db/pool.js";
import { deleteSession, existingMediaItems, existingRooms, idleSessions, touchSession } from "./db/repositories.js";
import { mediaFolder, roomFolder, storage } from "./storage/local.js";

/**
 * How long anything lives. A session nobody has touched for SESSION_TTL_DAYS
 * (3 by default) is deleted - rooms, uploads, notes, chat, files - and storage
 * nothing points at any more is swept. Rooms are workspaces for a study
 * session, not an archive; the landing page says so.
 *
 * Activity is recorded at most every few minutes per session per replica, so
 * typing in the notes does not become a write per keystroke. An open tab counts
 * as activity (its socket's heartbeat touches the session), so a session is
 * never deleted from under someone looking at it.
 */

const TOUCH_EVERY_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const FIRST_SWEEP_MS = 2 * 60 * 1000;
/** Only one replica sweeps at a time. */
const SWEEP_LOCK = 0x524d_6c63; // "RMlc"

const touched = new Map<string, number>();

/** Something happened in this session: it is in use, and is not to expire. */
export function touch(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  const now = Date.now();
  if (now - (touched.get(sessionId) ?? 0) < TOUCH_EVERY_MS) return;
  touched.set(sessionId, now);
  void touchSession(sessionId).catch((err: unknown) => console.warn("[lifecycle] touch failed", err));
}

export interface SweepResult {
  sessions: number;
  orphanRooms: number;
  orphanUploads: number;
}

/** Deletes idle sessions, then any stored folder whose room or upload no longer exists. */
export async function sweep(now = Date.now()): Promise<SweepResult> {
  const client = await pool.connect();
  const result: SweepResult = { sessions: 0, orphanRooms: 0, orphanUploads: 0 };
  try {
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock($1) AS locked`, [SWEEP_LOCK]);
    if (!rows[0]?.locked) return result;
    try {
      for (;;) {
        const idle = await idleSessions(now - config.sessionTtlMs);
        if (idle.length === 0) break;
        for (const session of idle) {
          await deleteSession(session.id);
          for (const roomId of session.roomIds) {
            await storage.removeTree(roomFolder(roomId)).catch(() => undefined);
          }
          touched.delete(session.id);
          result.sessions += 1;
        }
      }

      // Left behind: a worker that finished writing after its upload was
      // deleted, or a crash between deleting a row and its files.
      const roomDirs = await storage.listDirs("rooms");
      const liveRooms = await existingRooms(roomDirs);
      for (const roomId of roomDirs) {
        if (!liveRooms.has(roomId)) {
          await storage.removeTree(roomFolder(roomId)).catch(() => undefined);
          result.orphanRooms += 1;
          continue;
        }
        const mediaDirs = await storage.listDirs(roomFolder(roomId));
        const liveMedia = await existingMediaItems(mediaDirs);
        for (const mediaItemId of mediaDirs) {
          if (liveMedia.has(mediaItemId)) continue;
          await storage.removeTree(mediaFolder(roomId, mediaItemId)).catch(() => undefined);
          result.orphanUploads += 1;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock($1)`, [SWEEP_LOCK]);
    }
  } finally {
    client.release();
  }
  if (result.sessions || result.orphanRooms || result.orphanUploads) {
    console.log(
      `[lifecycle] deleted ${result.sessions} idle sessions; swept ${result.orphanRooms} rooms and ${result.orphanUploads} uploads left in storage`,
    );
  }
  return result;
}

let timer: NodeJS.Timeout | null = null;

export function startLifecycle(): void {
  const run = () => void sweep().catch((err: unknown) => console.warn("[lifecycle] sweep failed", err));
  timer = setTimeout(function again() {
    run();
    timer = setTimeout(again, SWEEP_EVERY_MS);
    timer.unref();
  }, FIRST_SWEEP_MS);
  timer.unref();
}

export function stopLifecycle(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
