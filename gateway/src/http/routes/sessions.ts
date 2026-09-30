import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  createRoom,
  createSession,
  getParticipant,
  getSessionByCode,
  isWaiting,
  listRooms,
  listWaiting,
  removeFromSession,
  sessionOwnerId,
  setWaiting,
  setWaitingRoom,
} from "../../db/repositories.js";
import { pubsub } from "../../ws/pubsub.js";
import { createDemo } from "../../demo.js";
import { checkDemo, codeGuessesBlocked, recordCodeMiss } from "../../limits.js";
import { asyncHandler } from "../asyncHandler.js";
import { sendRefusal } from "./media.js";
import { routeParam } from "../params.js";

export const sessionsRouter = Router();

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mainRoomName: z.string().trim().min(1).max(120).optional(),
});

const byOwner = z.object({ participantId: z.string().trim().min(1).max(64) });

/** The session and its owner, when the requester is that owner; answers the request otherwise. */
async function asOwner(req: Request, res: Response) {
  const parsed = byOwner.safeParse({ participantId: req.body?.participantId ?? req.query["participantId"] });
  const session = await getSessionByCode(routeParam(req, "code"), parsed.success ? parsed.data.participantId : undefined);
  if (!parsed.success || !session) {
    res.status(404).json({ error: "session_not_found" });
    return null;
  }
  const ownerId = await sessionOwnerId(session.id);
  if (ownerId !== parsed.data.participantId) {
    res.status(403).json({ error: "not_owner", message: "Only whoever started the session can do that." });
    return null;
  }
  const owner = await getParticipant(ownerId);
  return { session, owner: owner! };
}

// The waiting room, switched on or off by the session's owner.
sessionsRouter.patch(
  "/api/sessions/:code",
  asyncHandler(async (req, res) => {
    const found = await asOwner(req, res);
    if (!found) return;
    const parsed = z.object({ waitingRoom: z.boolean() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const session = await setWaitingRoom(found.session.id, parsed.data.waitingRoom);
    if (session) await pubsub.publishToSession(session.id, { type: "session_updated", session });
    res.json({ session });
  }),
);

// Who is waiting now, for an owner who arrives after they did.
sessionsRouter.get(
  "/api/sessions/:code/waiting",
  asyncHandler(async (req, res) => {
    const found = await asOwner(req, res);
    if (!found) return;
    res.json({ waiting: await listWaiting(found.session.id) });
  }),
);

sessionsRouter.post(
  "/api/sessions/:code/admissions",
  asyncHandler(async (req, res) => {
    const found = await asOwner(req, res);
    if (!found) return;
    const parsed = z.object({ targetId: z.string().trim().min(1).max(64), admit: z.boolean() }).safeParse(req.body ?? {});
    const target = parsed.success ? await getParticipant(parsed.data.targetId) : null;
    // Only someone actually waiting: denying a current member here would take
    // them out without closing their connections or changing the code. That is
    // what Remove is for.
    if (!parsed.success || !target || target.sessionId !== found.session.id || !(await isWaiting(target.id))) {
      res.status(404).json({ error: "not_found", message: "They are no longer waiting." });
      return;
    }
    if (parsed.data.admit) await setWaiting(target.id, false);
    else await removeFromSession(target.id);
    await pubsub.publishToSession(found.session.id, {
      type: "admission_decided",
      sessionId: found.session.id,
      participantId: target.id,
      admitted: parsed.data.admit,
      byName: found.owner.displayName,
    });
    res.status(204).end();
  }),
);

// "Try a sample room": a session already holding analysed material.
sessionsRouter.post(
  "/api/demo",
  asyncHandler(async (req, res) => {
    const refusal = await checkDemo(req.ip ?? "unknown");
    if (refusal) {
      sendRefusal(res, refusal);
      return;
    }
    res.status(201).json(await createDemo());
  }),
);

sessionsRouter.post(
  "/api/sessions",
  asyncHandler(async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "name must be a short string." });
      return;
    }

    const session = await createSession(parsed.data.name ?? null);
    const mainRoom = await createRoom(session.id, parsed.data.mainRoomName ?? "Main Room", true);
    res.status(201).json({ session, rooms: [mainRoom] });
  }),
);

sessionsRouter.get(
  "/api/sessions/:code",
  asyncHandler(async (req, res) => {
    const address = req.ip ?? "unknown";
    const blocked = await codeGuessesBlocked(address);
    if (blocked) {
      sendRefusal(res, blocked);
      return;
    }
    // A retired code still opens the session for a current member who says who they are.
    const participantId = typeof req.query["participantId"] === "string" ? req.query["participantId"] : undefined;
    const session = await getSessionByCode(routeParam(req, "code"), participantId);
    if (!session) {
      await recordCodeMiss(address);
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({ session, rooms: await listRooms(session.id) });
  }),
);
