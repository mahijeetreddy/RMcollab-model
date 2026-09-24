import { Router } from "express";
import { z } from "zod";
import { createRoom, createSession, getSessionByCode, listRooms } from "../../db/repositories.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

export const sessionsRouter = Router();

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  mainRoomName: z.string().trim().min(1).max(120).optional(),
});

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
    const session = await getSessionByCode(routeParam(req, "code"));
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({ session, rooms: await listRooms(session.id) });
  }),
);
