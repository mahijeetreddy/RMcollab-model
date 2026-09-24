import { nanoid } from "nanoid";

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const port = num(process.env.PORT, 4000);

export const config = {
  port,
  databaseUrl: process.env.DATABASE_URL ?? "postgres://rmcollab:rmcollab@localhost:5432/rmcollab",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379/0",
  storageRoot: process.env.STORAGE_ROOT ?? "/data/storage",
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
  // Identifies this process across replicas: pub/sub origin tagging, stream
  // consumer name, /health.
  replicaId: process.env.REPLICA_ID ?? `gw-${nanoid(8)}`,
  maxUploadBytes: num(process.env.MAX_UPLOAD_BYTES, 64 * 1024 * 1024),
  chatHistoryLimit: num(process.env.CHAT_HISTORY_LIMIT, 100),
  files: {
    // Uploaded media is served to <img>/<video> tags, which cannot send an auth
    // header, so URLs are presigned instead (the S3 approach). Every replica must
    // agree on the secret or links minted by one will fail on another, hence an
    // env var rather than a per-process random.
    signingSecret: process.env.FILE_SIGNING_SECRET ?? "dev-insecure-file-signing-secret",
    urlTtlSeconds: num(process.env.FILE_URL_TTL_SECONDS, 6 * 60 * 60),
  },
  webhooks: {
    // Outbound requests go to user-supplied URLs, which is an SSRF vector:
    // private/loopback/link-local targets are only reachable when this is on.
    // Production sets WEBHOOK_ALLOW_PRIVATE_URLS=false; it defaults to true here
    // so a localhost listener can be used to try the subsystem out.
    allowPrivateUrls: (process.env.WEBHOOK_ALLOW_PRIVATE_URLS ?? "true") !== "false",
    maxAttempts: num(process.env.WEBHOOK_MAX_ATTEMPTS, 5),
    timeoutMs: num(process.env.WEBHOOK_TIMEOUT_MS, 10_000),
    concurrency: num(process.env.WEBHOOK_CONCURRENCY, 5),
    pollIntervalMs: num(process.env.WEBHOOK_POLL_INTERVAL_MS, 250),
    backoffBaseMs: num(process.env.WEBHOOK_BACKOFF_BASE_MS, 1000),
    backoffCapMs: num(process.env.WEBHOOK_BACKOFF_CAP_MS, 60_000),
  },
} as const;

export type Config = typeof config;
