import { Router } from "express";
import { z } from "zod";
import {
  createWebhookEndpoint,
  deactivateWebhookEndpoint,
  getSessionByCode,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
} from "../../db/repositories.js";
import { scheduleDelivery } from "../../webhooks/queue.js";
import { generateSecret } from "../../webhooks/signature.js";
import { validateWebhookUrl } from "../../webhooks/urlGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

export const webhooksRouter = Router();

const createSchema = z.object({ url: z.string().trim().min(1).max(2048) });

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

webhooksRouter.post(
  "/api/sessions/:code/webhooks",
  asyncHandler(async (req, res) => {
    const session = await getSessionByCode(routeParam(req, "code"));
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }

    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "url is required." });
      return;
    }

    const check = await validateWebhookUrl(parsed.data.url);
    if (!check.ok) {
      res.status(400).json({ error: "invalid_url", message: check.reason });
      return;
    }

    const endpoint = await createWebhookEndpoint({
      sessionId: session.id,
      url: parsed.data.url,
      secret: generateSecret(),
    });
    // The secret is returned here and never again; the caller must store it now.
    res.status(201).json({ endpoint });
  }),
);

webhooksRouter.get(
  "/api/sessions/:code/webhooks",
  asyncHandler(async (req, res) => {
    const session = await getSessionByCode(routeParam(req, "code"));
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({ endpoints: await listWebhookEndpoints(session.id) });
  }),
);

webhooksRouter.delete(
  "/api/webhooks/:id",
  asyncHandler(async (req, res) => {
    const endpoint = await deactivateWebhookEndpoint(routeParam(req, "id"));
    if (!endpoint) {
      res.status(404).json({ error: "endpoint_not_found" });
      return;
    }
    res.json({ endpoint });
  }),
);

webhooksRouter.get(
  "/api/webhooks/:id/deliveries",
  asyncHandler(async (req, res) => {
    const endpoint = await getWebhookEndpoint(routeParam(req, "id"));
    if (!endpoint) {
      res.status(404).json({ error: "endpoint_not_found" });
      return;
    }
    const query = deliveriesQuerySchema.safeParse(req.query ?? {});
    if (!query.success) {
      res.status(400).json({ error: "invalid_query", message: "limit must be 1-200." });
      return;
    }
    res.json({ deliveries: await listWebhookDeliveries(endpoint.id, query.data.limit) });
  }),
);

webhooksRouter.post(
  "/api/webhooks/deliveries/:id/replay",
  asyncHandler(async (req, res) => {
    const delivery = await replayWebhookDelivery(routeParam(req, "id"));
    if (!delivery) {
      res.status(404).json({ error: "delivery_not_found" });
      return;
    }
    await scheduleDelivery(delivery.id, Date.now());
    res.status(202).json({ delivery, replayOf: routeParam(req, "id") });
  }),
);
