import { Router } from "express";
import { config } from "../../config.js";
import { pool } from "../../db/pool.js";
import { pubsub } from "../../ws/pubsub.js";
import { asyncHandler } from "../asyncHandler.js";

export const healthRouter = Router();

healthRouter.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const [dbResult, redisResult] = await Promise.allSettled([
      pool.query("SELECT 1"),
      pubsub.ping(),
    ]);
    const db = dbResult.status === "fulfilled";
    const redis = redisResult.status === "fulfilled";
    res.status(db && redis ? 200 : 503).json({
      status: db && redis ? "ok" : "degraded",
      replicaId: config.replicaId,
      db,
      redis,
    });
  }),
);
