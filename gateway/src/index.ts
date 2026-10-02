// First, before anything it should watch loads.
import { flushErrors } from "./instrument.js";
import http from "node:http";
import { Redis } from "ioredis";
import express, { type NextFunction, type Request, type Response } from "express";
import { config, productionProblems } from "./config.js";
import { migrate } from "./db/migrate.js";
import { backfillArtifactBodies } from "./db/repositories.js";
import { docHub } from "./docs/hub.js";
import { pool } from "./db/pool.js";
import { healthRouter } from "./http/routes/health.js";
import { libraryRouter } from "./http/routes/library.js";
import { filesRouter, mediaRouter } from "./http/routes/media.js";
import { closeMetrics, metricsRouter } from "./http/routes/metrics.js";
import { roomsRouter } from "./http/routes/rooms.js";
import { sessionsRouter } from "./http/routes/sessions.js";
import {
  startStrategyRefresh,
  stopStrategyRefresh,
  strategiesRouter,
} from "./http/routes/strategies.js";
import { webhooksRouter } from "./http/routes/webhooks.js";
import { backfillPassages, embeddingConsumer } from "./ask/indexer.js";
import { closeAsk } from "./ask/service.js";
import { jobEventConsumer } from "./jobs/eventConsumer.js";
import { startLifecycle, stopLifecycle } from "./lifecycle.js";
import { startDispatcher, stopDispatcher } from "./queue/dispatcher.js";
import { closeLimits } from "./limits.js";
import { closePresence } from "./ws/presence.js";
import { manageRouter } from "./http/routes/manage.js";
import { versionsRouter } from "./http/routes/versions.js";
import { documentsRouter } from "./http/routes/documents.js";
import { queueRouter } from "./http/routes/queue.js";
import { closeWebhookQueue } from "./webhooks/queue.js";
import { pubsub } from "./ws/pubsub.js";
import { createWebSocketServer } from "./ws/server.js";

function cors(req: Request, res: Response, next: NextFunction): void {
  const origins = config.allowedOrigins;
  if (origins.includes("*")) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else {
    // Named origins: echo the caller's when it is one of them, and nothing
    // otherwise - the browser then refuses the response to any other site.
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}

async function main(): Promise<void> {
  const problems = productionProblems();
  if (problems.length > 0) {
    throw new Error(`refusing to start in production:\n  - ${problems.join("\n  - ")}`);
  }
  await migrate();
  // Off the boot path: indexing old documents must not delay taking traffic.
  // Then split them for Ask the room: bodies first, since passages are made from them.
  void backfillArtifactBodies()
    .then((filled) => filled && console.log(`[library] indexed ${filled} existing documents`))
    .then(async () => {
      const backfillRedis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
      try {
        const { split, queued } = await backfillPassages(backfillRedis);
        if (split || queued) console.log(`[ask] split ${split} passages, re-queued ${queued} for embedding`);
      } finally {
        backfillRedis.disconnect();
      }
    })
    .catch((err: unknown) => console.warn("[library] backfill failed", err));

  const app = express();
  app.disable("x-powered-by");
  // One hop: the nginx load balancer, which sets X-Forwarded-For. Without this
  // every request would appear to come from the balancer, and per-address
  // limits (sample rooms) would be one shared allowance for the whole world.
  app.set("trust proxy", Number(process.env.TRUSTED_PROXY_HOPS ?? 1));
  app.use(cors);
  app.options(/.*/, (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);
  app.use(sessionsRouter);
  app.use(roomsRouter);
  app.use(strategiesRouter);
  app.use(metricsRouter);
  app.use(mediaRouter);
  app.use(manageRouter);
  app.use(versionsRouter);
  app.use(documentsRouter);
  app.use(queueRouter);
  app.use(libraryRouter);
  app.use(webhooksRouter);
  app.use(filesRouter);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // An upload past the size limit that did not say its size up front (see
    // media.ts): the person's mistake, not the gateway's.
    if ((err as { code?: unknown }).code === "LIMIT_FILE_SIZE") {
      if (!res.headersSent) {
        res.status(413).json({
          error: "file_too_large",
          message: `Files can be up to ${Math.round(config.maxUploadBytes / (1024 * 1024))} MB.`,
        });
      }
      return;
    }
    console.error("[http] unhandled", err);
    const message = err instanceof Error ? err.message : "unexpected error";
    if (!res.headersSent) res.status(500).json({ error: "internal_error", message });
  });

  const server = http.createServer(app);
  const wss = createWebSocketServer(server);
  await jobEventConsumer.start();
  await embeddingConsumer.start();
  startLifecycle();
  startDispatcher();
  startStrategyRefresh();

  await new Promise<void>((resolve) => server.listen(config.port, resolve));
  console.log(`[gateway] replica ${config.replicaId} listening on :${config.port}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[gateway] ${signal} received, shutting down`);

    for (const socket of wss.clients) socket.close(1001, "server shutting down");
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await jobEventConsumer.stop();
    await embeddingConsumer.stop();
    await closeAsk();
    stopLifecycle();
    await stopDispatcher();
    await closeLimits();
    await closePresence();
    // Unsaved note edits (at most one batch window's worth) go to Postgres
    // before the pool closes.
    await docHub.flushAll().catch((err: unknown) => console.error("[docs] final flush failed", err));
    await stopStrategyRefresh();
    await closeMetrics();
    await closeWebhookQueue();
    await pubsub.close();
    await pool.end();
    await flushErrors();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[gateway] boot failed", err);
  void flushErrors().finally(() => process.exit(1));
});
