import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../../config.js";
import {
  createWebhookEndpoint,
  deactivateWebhookEndpoint,
  getSessionByCode,
  getWebhookEndpoint,
  listWebhookDeliveries,
  listWebhookEndpoints,
  replayWebhookDelivery,
  sessionOwnerId,
  webhookDeliverySessionId,
} from "../../db/repositories.js";
import { scheduleDelivery } from "../../webhooks/queue.js";
import { generateSecret } from "../../webhooks/signature.js";
import { validateWebhookUrl } from "../../webhooks/urlGuard.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

/**
 * Webhooks: a session's job events, POSTed to a URL its owner registers.
 *
 * Owner-only, every route. An endpoint receives each job event of the session,
 * signed links to the uploaded files included, so registering one is reading
 * everything; and its deliveries hold those same payloads. Who is asking is the
 * `participantId` in the body or query (guest identity: as strong as that id).
 * Off entirely in production unless WEBHOOKS_ENABLED=true - see config.ts.
 */
export const webhooksRouter = Router();

const createSchema = z.object({ url: z.string().trim().min(1).max(2048) });

const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function enabled(_req: Request, res: Response, next: NextFunction): void {
  if (config.webhooks.enabled) {
    next();
    return;
  }
  res.status(404).json({ error: "webhooks_disabled", message: "Webhooks are not enabled on this server." });
}
webhooksRouter.use(["/api/sessions/:code/webhooks", "/api/webhooks"], enabled);

function requester(req: Request): string | null {
  const fromBody = typeof req.body?.participantId === "string" ? (req.body.participantId as string) : null;
  const fromQuery = typeof req.query["participantId"] === "string" ? req.query["participantId"] : null;
  return fromBody ?? fromQuery;
}

/** True when the requester owns `sessionId`; answers 403 otherwise. */
async function ownerOf(req: Request, res: Response, sessionId: string): Promise<boolean> {
  const participantId = requester(req);
  if (participantId && participantId === (await sessionOwnerId(sessionId))) return true;
  res.status(403).json({ error: "not_owner", message: "Only whoever started the session can manage its webhooks." });
  return false;
}

/** The session named in the URL, when the requester owns it. */
async function ownedSession(req: Request, res: Response) {
  const session = await getSessionByCode(routeParam(req, "code"), requester(req) ?? undefined);
  if (!session) {
    res.status(404).json({ error: "session_not_found" });
    return null;
  }
  return (await ownerOf(req, res, session.id)) ? session : null;
}

/** The endpoint named in the URL, when the requester owns its session. */
async function ownedEndpoint(req: Request, res: Response) {
  const endpoint = await getWebhookEndpoint(routeParam(req, "id"));
  if (!endpoint) {
    res.status(404).json({ error: "endpoint_not_found" });
    return null;
  }
  return (await ownerOf(req, res, endpoint.sessionId)) ? endpoint : null;
}

webhooksRouter.post(
  "/api/sessions/:code/webhooks",
  asyncHandler(async (req, res) => {
    const session = await ownedSession(req, res);
    if (!session) return;

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
    const session = await ownedSession(req, res);
    if (!session) return;
    res.json({ endpoints: await listWebhookEndpoints(session.id) });
  }),
);

webhooksRouter.delete(
  "/api/webhooks/:id",
  asyncHandler(async (req, res) => {
    const owned = await ownedEndpoint(req, res);
    if (!owned) return;
    res.json({ endpoint: await deactivateWebhookEndpoint(owned.id) });
  }),
);

webhooksRouter.get(
  "/api/webhooks/:id/deliveries",
  asyncHandler(async (req, res) => {
    const endpoint = await ownedEndpoint(req, res);
    if (!endpoint) return;
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
    const sessionId = await webhookDeliverySessionId(routeParam(req, "id"));
    if (!sessionId) {
      res.status(404).json({ error: "delivery_not_found" });
      return;
    }
    if (!(await ownerOf(req, res, sessionId))) return;
    const delivery = await replayWebhookDelivery(routeParam(req, "id"));
    if (!delivery) {
      res.status(404).json({ error: "delivery_not_found" });
      return;
    }
    await scheduleDelivery(delivery.id, Date.now());
    res.status(202).json({ delivery, replayOf: routeParam(req, "id") });
  }),
);
