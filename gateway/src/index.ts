import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { migrate } from "./db/migrate.js";
import { pool } from "./db/pool.js";
import { healthRouter } from "./http/routes/health.js";
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
import { jobEventConsumer } from "./jobs/eventConsumer.js";
import { closeWebhookQueue } from "./webhooks/queue.js";
import { pubsub } from "./ws/pubsub.js";
import { createWebSocketServer } from "./ws/server.js";

function cors(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}

async function main(): Promise<void> {
  await migrate();

  const app = express();
  app.disable("x-powered-by");
  app.use(cors);
  app.options(/.*/, (_req, res) => res.sendStatus(204));
  app.use(express.json({ limit: "1mb" }));

  app.use(healthRouter);
  app.use(sessionsRouter);
  app.use(roomsRouter);
  app.use(strategiesRouter);
  app.use(metricsRouter);
  app.use(mediaRouter);
  app.use(webhooksRouter);
  app.use(filesRouter);

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("[http] unhandled", err);
    const message = err instanceof Error ? err.message : "unexpected error";
    if (!res.headersSent) res.status(500).json({ error: "internal_error", message });
  });

  const server = http.createServer(app);
  const wss = createWebSocketServer(server);
  await jobEventConsumer.start();
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
    await stopStrategyRefresh();
    await closeMetrics();
    await closeWebhookQueue();
    await pubsub.close();
    await pool.end();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[gateway] boot failed", err);
  process.exit(1);
});
