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
    signingSecret: process.env.FILE_SIGNING_SECRET || "dev-insecure-file-signing-secret",
    urlTtlSeconds: num(process.env.FILE_URL_TTL_SECONDS, 6 * 60 * 60),
  },
  webhooks: {
    // Off in production unless asked for: no part of the app uses them, and an
    // endpoint receives every job event of its session, signed file links
    // included. When on, only the session's owner can manage them.
    enabled: (process.env.WEBHOOKS_ENABLED ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",
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
  // Abuse and cost limits (see limits.ts). Anyone with a session code can
  // upload, and every upload is GPU or model work.
  limits: {
    uploadsPerPersonPerMinute: num(process.env.LIMIT_UPLOADS_PER_MINUTE, 10),
    uploadsPerPersonPerHour: num(process.env.LIMIT_UPLOADS_PER_HOUR, 60),
    uploadsPerSessionPerHour: num(process.env.LIMIT_SESSION_UPLOADS_PER_HOUR, 200),
    activeJobsPerSession: num(process.env.LIMIT_ACTIVE_JOBS_PER_SESSION, 12),
    roomStorageBytes: num(process.env.LIMIT_ROOM_STORAGE_MB, 500) * 1024 * 1024,
    sessionStorageBytes: num(process.env.LIMIT_SESSION_STORAGE_MB, 2048) * 1024 * 1024,
    demosPerAddressPerHour: num(process.env.LIMIT_DEMOS_PER_HOUR, 6),
    // Per address, so generous: a class on school wifi is one address.
    sessionsPerAddressPerHour: num(process.env.LIMIT_SESSIONS_PER_HOUR, 30),
    connectionsPerAddress: num(process.env.LIMIT_CONNECTIONS_PER_ADDRESS, 100),
    codeMissesPer10Minutes: num(process.env.LIMIT_CODE_MISSES_PER_10_MIN, 20),
  },
  // Sessions nobody has touched in this long are deleted, files and all.
  sessionTtlMs: num(process.env.SESSION_TTL_DAYS, 3) * 24 * 60 * 60 * 1000,
  // ...or this long, for a session its owner chose to keep (a group that meets
  // weekly would otherwise lose it between meetings).
  sessionKeepMs: num(process.env.SESSION_KEEP_DAYS, 30) * 24 * 60 * 60 * 1000,
  // Which pages may call the API from a browser. "*" in development, where the
  // app is served from another port; in production the app is served from the
  // gateway's own origin, and this is that origin (comma-separated for several).
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
  production: process.env.NODE_ENV === "production",
  // Jobs kept waiting in each worker pool's broker queue (queue/dispatcher.ts):
  // enough that a worker always has the next one ready, few enough that the
  // order is still chosen fairly when a new session's job arrives.
  dispatchAhead: num(process.env.DISPATCH_AHEAD, 2),
  // /api/metrics in production: only with this token (Authorization: Bearer),
  // and not at all without one. Open in development, for the cluster panel.
  metricsToken: process.env.METRICS_TOKEN?.trim() || null,
} as const;

export type Config = typeof config;

export const DEV_FILE_SIGNING_SECRET = "dev-insecure-file-signing-secret";

/**
 * What production must not start without. Each of these has a default that is
 * fine on a laptop and a hole on the internet: a public signing secret lets
 * anyone mint a link to any stored file, and "*" lets any site call the API
 * from its visitors' browsers.
 */
export function productionProblems(c: Config = config): string[] {
  if (!c.production) return [];
  const problems: string[] = [];
  if (c.files.signingSecret === DEV_FILE_SIGNING_SECRET || c.files.signingSecret.length < 32) {
    problems.push("FILE_SIGNING_SECRET must be set to a random value of at least 32 characters (openssl rand -hex 32).");
  }
  if (c.allowedOrigins.includes("*")) problems.push("ALLOWED_ORIGINS must name the app's origin, e.g. https://rmcollab.example.");
  if (c.webhooks.allowPrivateUrls) problems.push("WEBHOOK_ALLOW_PRIVATE_URLS must be false: webhooks could otherwise reach internal services.");
  if (!c.publicBaseUrl.startsWith("https://")) problems.push("PUBLIC_BASE_URL must be the public https:// address.");
  return problems;
}
