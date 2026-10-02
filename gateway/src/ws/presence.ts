import { Redis } from "ioredis";
import { config } from "../config.js";

/**
 * Who is still here, when one person has several connections: two tabs, or a
 * laptop and a phone (the private device link invites exactly that). Without
 * it, closing one tab told the room that person had left - they vanished from
 * everyone's list while still there in the other - and marked them
 * disconnected for the whole session.
 *
 * One sorted set per (scope, participant), members the connection ids, scores
 * when each stops counting: a connection renews its own on every heartbeat,
 * so one whose replica died stops counting within a minute and a half rather
 * than keeping its person "present" for ever. Shared through Redis, so it
 * counts connections on every replica. If Redis cannot answer, each
 * connection counts alone, which is how it was before.
 */

const TTL_MS = 90_000;

let redis: Redis | null = null;
function client(): Redis {
  redis ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  return redis;
}

const key = (scope: string, participantId: string) => `rmcollab:presence:${scope}:${participantId}`;

/** This connection is here (or still here: heartbeats call it again). */
export async function here(scope: string, participantId: string, connId: string): Promise<void> {
  try {
    await client()
      .multi()
      .zadd(key(scope, participantId), Date.now() + TTL_MS, connId)
      .pexpire(key(scope, participantId), TTL_MS)
      .exec();
  } catch {
    // Best effort: see above.
  }
}

/** This connection has gone. Resolves with how many of the person's connections remain. */
export async function gone(scope: string, participantId: string, connId: string): Promise<number> {
  try {
    const results = await client()
      .multi()
      .zrem(key(scope, participantId), connId)
      .zremrangebyscore(key(scope, participantId), 0, Date.now())
      .zcard(key(scope, participantId))
      .exec();
    return Number(results?.[2]?.[1] ?? 0);
  } catch {
    return 0;
  }
}

export async function closePresence(): Promise<void> {
  if (redis) await redis.quit().catch(() => undefined);
  redis = null;
}
