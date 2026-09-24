import { WEBHOOK_RETRY_ZSET } from "@rmcollab/shared";
import { Redis } from "ioredis";
import { config } from "../config.js";

// Due work lives in a Redis sorted set scored by due-at epoch ms, not in a
// setTimeout: an in-process timer drops every pending retry when the dispatcher
// restarts or is rescheduled, which is exactly when retries matter most. The
// sorted set also lets several dispatcher replicas share one backlog.
const CLAIM_DUE = `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
if #due > 0 then
  redis.call('ZREM', KEYS[1], unpack(due))
end
return due
`;

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    client.on("error", (err) => console.error("[webhooks] redis", err.message));
  }
  return client;
}

export async function scheduleDelivery(deliveryId: string, dueAt: number): Promise<void> {
  await redis().zadd(WEBHOOK_RETRY_ZSET, dueAt, deliveryId);
}

/** Pops up to `count` deliveries whose due-at has passed; the ZREM is the claim. */
export async function claimDueDeliveries(count: number): Promise<string[]> {
  if (count <= 0) return [];
  const result = await redis().eval(CLAIM_DUE, 1, WEBHOOK_RETRY_ZSET, Date.now(), count);
  return (result as string[]) ?? [];
}

export async function pendingRetryCount(): Promise<number> {
  return redis().zcard(WEBHOOK_RETRY_ZSET);
}

export async function closeWebhookQueue(): Promise<void> {
  if (!client) return;
  await client.quit().catch(() => undefined);
  client = null;
}
