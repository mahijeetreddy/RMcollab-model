import { Redis } from "ioredis";
import { config } from "./config.js";
import { pool } from "./db/pool.js";

/**
 * Abuse and cost limits for work that costs something: uploads (each one a
 * GPU or model job) and the storage they fill. Anyone with a session code can
 * upload, so the limits are per person, per session and per room, counted in
 * Redis so every gateway replica enforces the same numbers.
 *
 * A refusal says which limit and when it lifts, in words, because the person
 * hitting it is usually not abusing anything - just dropping a folder in.
 */

export interface Refusal {
  status: 413 | 429;
  error: string;
  message: string;
  retryAfterS?: number;
}

let redis: Redis | null = null;
function client(): Redis {
  redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

/**
 * Counts one event in a sliding window; true while the last `windowS` seconds
 * hold at most `max`. Sliding, not fixed: with fixed windows, events either
 * side of a window's edge counted separately, letting twice the limit through
 * in a moment. Each event is a timestamp in a sorted set.
 */
async function within(key: string, windowS: number, max: number): Promise<{ ok: boolean; retryAfterS: number }> {
  const full = `rmcollab:limit:${key}`;
  const now = Date.now();
  const since = now - windowS * 1000;
  const results = (await client()
    .multi()
    .zremrangebyscore(full, 0, since)
    .zadd(full, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
    .zcard(full)
    .zrange(full, 0, 0, "WITHSCORES")
    .expire(full, windowS + 5)
    .exec()) as [Error | null, unknown][];
  const count = Number(results[2]?.[1] ?? 0);
  const oldest = Number((results[3]?.[1] as string[] | undefined)?.[1] ?? now);
  // When the oldest counted event leaves the window, there is room again.
  const retryAfterS = Math.max(1, Math.ceil((oldest + windowS * 1000 - now) / 1000));
  return { ok: count <= max, retryAfterS };
}

const mb = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * Whether an upload of `bytes` may go ahead. Checked before anything is stored.
 * Rate windows are counted even when a later check refuses, which is the point:
 * someone hammering a full room is still hammering.
 */
export async function checkUpload(input: {
  participantId: string;
  sessionId: string;
  roomId: string;
  bytes: number;
}): Promise<Refusal | null> {
  const l = config.limits;
  try {
    const perMinute = await within(`upload:p:${input.participantId}:m`, 60, l.uploadsPerPersonPerMinute);
    if (!perMinute.ok) {
      return {
        status: 429,
        error: "upload_rate_limited",
        message: `That's a lot of uploads in a minute (the limit is ${l.uploadsPerPersonPerMinute}). Wait a moment and add the rest.`,
        retryAfterS: perMinute.retryAfterS,
      };
    }
    const perHour = await within(`upload:p:${input.participantId}:h`, 3600, l.uploadsPerPersonPerHour);
    if (!perHour.ok) {
      return {
        status: 429,
        error: "upload_rate_limited",
        message: `You've added ${l.uploadsPerPersonPerHour} items this hour, the most one person can. Try again later.`,
        retryAfterS: perHour.retryAfterS,
      };
    }
    const session = await within(`upload:s:${input.sessionId}:h`, 3600, l.uploadsPerSessionPerHour);
    if (!session.ok) {
      return {
        status: 429,
        error: "session_rate_limited",
        message: `This session has added ${l.uploadsPerSessionPerHour} items this hour, its limit. Try again later.`,
        retryAfterS: session.retryAfterS,
      };
    }
  } catch (err) {
    // Redis unreachable: fail open. An outage of the counter is not a reason
    // to refuse the work; the storage and job checks below still apply.
    console.warn("[limits] rate check skipped", err instanceof Error ? err.message : err);
  }

  const { rows } = await pool.query<{ room_bytes: string; session_bytes: string; active_jobs: string }>(
    `SELECT
       coalesce(sum(m.size_bytes) FILTER (WHERE m.room_id = $2), 0) AS room_bytes,
       coalesce(sum(m.size_bytes), 0) AS session_bytes,
       (SELECT count(*) FROM enhancement_jobs j
          JOIN media_items mj ON mj.id = j.media_item_id
          JOIN rooms rj ON rj.id = mj.room_id
          WHERE rj.session_id = $1 AND j.status IN ('queued', 'processing')) AS active_jobs
     FROM media_items m JOIN rooms r ON r.id = m.room_id
     WHERE r.session_id = $1`,
    [input.sessionId, input.roomId],
  );
  const usage = rows[0]!;
  if (Number(usage.active_jobs) >= l.activeJobsPerSession) {
    return {
      status: 429,
      error: "too_many_jobs",
      message: `This session already has ${l.activeJobsPerSession} items being processed. Add more once some finish.`,
      retryAfterS: 30,
    };
  }
  if (Number(usage.room_bytes) + input.bytes > l.roomStorageBytes) {
    return {
      status: 413,
      error: "room_storage_full",
      message: `This room is full: it holds up to ${mb(l.roomStorageBytes)} of uploads. Delete something to make room.`,
    };
  }
  if (Number(usage.session_bytes) + input.bytes > l.sessionStorageBytes) {
    return {
      status: 413,
      error: "session_storage_full",
      message: `This session is full: its rooms hold up to ${mb(l.sessionStorageBytes)} of uploads together. Delete something to make room.`,
    };
  }
  return null;
}

/**
 * Session codes are long enough not to be guessed, and this makes sure of it:
 * an address that tries too many codes that do not exist is refused for a
 * while. Only misses count - rejoining your own session costs nothing.
 */
export async function codeGuessesBlocked(address: string): Promise<Refusal | null> {
  try {
    const count = await client().zcount(`rmcollab:limit:code-miss:${address}`, Date.now() - 10 * 60_000, "+inf");
    if (count >= config.limits.codeMissesPer10Minutes) {
      return {
        status: 429,
        error: "too_many_wrong_codes",
        message: "Too many session codes that don't exist. Check the code and try again in a few minutes.",
        retryAfterS: 600,
      };
    }
  } catch {
    // Fail open.
  }
  return null;
}

export async function recordCodeMiss(address: string): Promise<void> {
  try {
    await within(`code-miss:${address}`, 10 * 60, Number.MAX_SAFE_INTEGER);
  } catch {
    // Best effort.
  }
}

/** Creating demo rooms costs storage and a little work; a few an hour per address is plenty. */
export async function checkDemo(address: string): Promise<Refusal | null> {
  try {
    const hour = await within(`demo:${address}`, 3600, config.limits.demosPerAddressPerHour);
    if (!hour.ok) {
      return {
        status: 429,
        error: "demo_rate_limited",
        message: "You've opened several sample rooms already. Rejoin one from Recent sessions, or try again later.",
        retryAfterS: hour.retryAfterS,
      };
    }
  } catch {
    // Fail open, as above.
  }
  return null;
}

export async function closeLimits(): Promise<void> {
  if (redis) await redis.quit().catch(() => undefined);
  redis = null;
}
