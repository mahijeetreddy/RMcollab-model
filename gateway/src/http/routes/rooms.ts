import { Router } from "express";
import { z } from "zod";
import {
  createRoom,
  deleteChatMessage,
  getChatMessageAuthor,
  getParticipant,
  getRoom,
  getRoomCodeForOwner,
  hasRoomAccess,
  sessionOwnerId,
  getSessionByCode,
  isAdmittedMember,
  listRooms,
} from "../../db/repositories.js";
import { pubsub } from "../../ws/pubsub.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

export const roomsRouter = Router();

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(120),
  // Optional: locks the room so only people given this code can enter.
  accessCode: z.string().trim().min(3).max(64).optional(),
  // Who created it: they become the owner and can reveal the code to share it.
  participantId: z.string().trim().min(1).max(64),
});

roomsRouter.post(
  "/api/sessions/:code/rooms",
  asyncHandler(async (req, res) => {
    const parsed = createRoomSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "name and participantId are required." });
      return;
    }
    // By its participant id, a member still finds the session after its code
    // changed (a removal retires the old one).
    const session = await getSessionByCode(routeParam(req, "code"), parsed.data.participantId);
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    // Only someone in the session makes rooms in it: not a passer-by holding
    // the code, not someone removed from it, not someone still waiting to be let in.
    if (!(await isAdmittedMember(session.id, parsed.data.participantId))) {
      res.status(403).json({ error: "not_in_session", message: "Join the session first." });
      return;
    }

    const room = await createRoom(
      session.id,
      parsed.data.name,
      false,
      parsed.data.accessCode ?? null,
      parsed.data.participantId,
    );
    const rooms = await listRooms(session.id);
    await pubsub.publishToSession(session.id, {
      type: "rooms_updated",
      sessionId: session.id,
      rooms,
    });
    res.status(201).json({ room, rooms });
  }),
);

roomsRouter.get(
  "/api/sessions/:code/rooms",
  asyncHandler(async (req, res) => {
    const session = await getSessionByCode(routeParam(req, "code"));
    if (!session) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    res.json({ rooms: await listRooms(session.id) });
  }),
);

// Deleting a chat message: its author can, and so can the room's owner and
// the session's owner - moderation for whoever is responsible for the room.
roomsRouter.delete(
  "/api/rooms/:roomId/messages/:messageId",
  asyncHandler(async (req, res) => {
    const room = await getRoom(routeParam(req, "roomId"));
    const participantId = typeof req.query["participantId"] === "string" ? req.query["participantId"] : "";
    const participant = participantId ? await getParticipant(participantId) : null;
    if (!room || !participant || participant.sessionId !== room.sessionId || !(await hasRoomAccess(room.id, participant.id))) {
      res.status(403).json({ error: "not_in_room", message: "Join the room first." });
      return;
    }
    const message = await getChatMessageAuthor(routeParam(req, "messageId"));
    if (!message || message.roomId !== room.id) {
      res.status(404).json({ error: "not_found", message: "That message is already gone." });
      return;
    }
    const mayDelete =
      message.participantId === participant.id ||
      room.ownerId === participant.id ||
      (await sessionOwnerId(room.sessionId)) === participant.id;
    if (!mayDelete) {
      res.status(403).json({ error: "not_allowed", message: "Only whoever wrote it, or an owner, can delete a message." });
      return;
    }
    await deleteChatMessage(routeParam(req, "messageId"));
    await pubsub.publishToRoom(room.id, { type: "chat_message_deleted", roomId: room.id, messageId: routeParam(req, "messageId") });
    res.status(204).end();
  }),
);

// The owner reveals the code to pass it on. Guest identity means a participantId
// is effectively a bearer token, so this is exactly as strong as that id.
roomsRouter.get(
  "/api/rooms/:roomId/code",
  asyncHandler(async (req, res) => {
    const participantId = typeof req.query["participantId"] === "string"
      ? req.query["participantId"]
      : "";
    if (!participantId) {
      res.status(400).json({ error: "participant_required" });
      return;
    }
    const code = await getRoomCodeForOwner(routeParam(req, "roomId"), participantId);
    if (code === null) {
      res.status(403).json({ error: "not_room_owner" });
      return;
    }
    res.json({ code });
  }),
);
