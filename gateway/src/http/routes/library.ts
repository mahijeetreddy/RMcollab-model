import { Router } from "express";
import { z } from "zod";
import { getParticipant, getRoom, hasRoomAccess, listLibrary } from "../../db/repositories.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

const querySchema = z.object({
  participantId: z.string().trim().min(1).max(64),
  q: z.string().max(200).optional(),
});

export const libraryRouter = Router();

/**
 * A room's documents, optionally searched. Guarded exactly like uploading: the
 * library holds everything a locked room has discussed, so being in the session
 * is not enough to read it.
 */
libraryRouter.get(
  "/api/rooms/:roomId/library",
  asyncHandler(async (req, res) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query", message: "participantId is required." });
      return;
    }
    const room = await getRoom(routeParam(req, "roomId"));
    if (!room) {
      res.status(404).json({ error: "room_not_found" });
      return;
    }
    const participant = await getParticipant(parsed.data.participantId);
    if (!participant || participant.sessionId !== room.sessionId) {
      res.status(403).json({ error: "participant_not_in_session" });
      return;
    }
    if (!(await hasRoomAccess(room.id, participant.id))) {
      res.status(403).json({ error: "room_locked", message: "You do not have access to this room." });
      return;
    }

    const query = parsed.data.q?.trim() || null;
    const entries = await listLibrary(room.id, query);
    res.json({ entries, query });
  }),
);
