import type { MediaType, StrategyDescriptor } from "@rmcollab/shared";
import { Router } from "express";
import { Redis } from "ioredis";
import { config } from "../../config.js";

// Workers advertise what they can actually run into Redis under a TTL and
// refresh it on a heartbeat (workers/common/advertise.py). The gateway only
// mirrors that, so the picker reflects the pools currently online instead of a
// list baked into this process.
const KEY_PREFIX = "rmcollab:strategies";
const REFRESH_MS = 15_000;

/** Defer the choice to the worker's registry, which owns default resolution. */
export const DEFAULT_STRATEGY = "auto";

let client: Redis | null = null;
let cache: StrategyDescriptor[] = [];
let timer: NodeJS.Timeout | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    client.on("error", (err) => console.error("[strategies]", err.message));
  }
  return client;
}

async function scanKeys(): Promise<string[]> {
  const found: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis().scan(cursor, "MATCH", `${KEY_PREFIX}:*`, "COUNT", 100);
    cursor = next;
    found.push(...batch);
  } while (cursor !== "0");
  return found;
}

export async function refreshStrategies(): Promise<StrategyDescriptor[]> {
  const keys = await scanKeys();
  if (keys.length === 0) {
    cache = [];
    return cache;
  }

  const values = await redis().mget(keys);
  const parsed: StrategyDescriptor[] = [];
  for (const value of values) {
    if (!value) continue;
    try {
      const info = JSON.parse(value) as {
        name: string;
        label: string;
        description: string;
        media_type: MediaType;
        is_default: boolean;
        available: boolean;
      };
      parsed.push({
        mediaType: info.media_type,
        name: info.name,
        label: info.label,
        description: info.description,
        isDefault: info.is_default,
        available: info.available,
      });
    } catch {
      // A malformed advert shouldn't blank the whole picker.
    }
  }

  parsed.sort((a, b) =>
    a.mediaType === b.mediaType
      ? Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)
      : a.mediaType.localeCompare(b.mediaType),
  );
  cache = parsed;
  return cache;
}

export function startStrategyRefresh(): void {
  if (timer) return;
  void refreshStrategies().catch(() => undefined);
  timer = setInterval(() => void refreshStrategies().catch(() => undefined), REFRESH_MS);
  timer.unref();
}

export async function stopStrategyRefresh(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (client) {
    await client.quit();
    client = null;
  }
}

export const strategiesRouter = Router();

strategiesRouter.get("/api/strategies", async (_req, res) => {
  const strategies = cache.length > 0 ? cache : await refreshStrategies();
  res.json({ strategies });
});

/**
 * Registered-but-unavailable names pass through on purpose: the worker resolves
 * them and reports *why* it fell back, which is information the user should see.
 * Substituting a default here would silently discard it.
 */
export function isKnownStrategy(mediaType: MediaType, name: string): boolean {
  if (name === DEFAULT_STRATEGY) return true;
  if (cache.length === 0) return true;
  return cache.some((s) => s.mediaType === mediaType && s.name === name);
}
