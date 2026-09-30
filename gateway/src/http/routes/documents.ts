import { MAX_TITLE_CHARS } from "@rmcollab/shared";
import { docKey, isDocId, MAIN_DOC_ID } from "@rmcollab/shared/notes";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { getParticipant, getRoom, hasRoomAccess, touchSession } from "../../db/repositories.js";
import { createDocument, deleteDocument, getDocument, listDocuments, MAX_DOCUMENTS_PER_ROOM, renameDocument } from "../../db/roomDocs.js";
import { docHub } from "../../docs/hub.js";
import { pubsub } from "../../ws/pubsub.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

/**
 * A room's documents. Its notes ("Room notes", where uploads write) always
 * exist; people add more. Anyone in the room may create one and edit any of
 * them - it is a shared workspace - but only whoever made a document, or the
 * room's owner, may rename or delete it.
 */
export const documentsRouter = Router();

const titleOf = (raw: string | undefined) =>
  (raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);

interface Member {
  roomId: string;
  ownerId: string | null;
  sessionId: string;
  participantId: string;
}

export async function roomMember(req: Request, res: Response): Promise<Member | null> {
  const room = await getRoom(routeParam(req, "roomId"));
  const participantId =
    (typeof req.query["participantId"] === "string" ? req.query["participantId"] : undefined) ??
    (typeof req.body?.participantId === "string" ? (req.body.participantId as string) : undefined);
  const participant = participantId ? await getParticipant(participantId) : null;
  if (!room || !participant || participant.sessionId !== room.sessionId || !(await hasRoomAccess(room.id, participant.id))) {
    res.status(403).json({ error: "not_in_room", message: "Join the room first." });
    return null;
  }
  return { roomId: room.id, ownerId: room.ownerId, sessionId: room.sessionId, participantId: participant.id };
}

async function announce(roomId: string): Promise<void> {
  await pubsub.publishToRoom(roomId, { type: "documents_updated", roomId, documents: await listDocuments(roomId) });
}

documentsRouter.get(
  "/api/rooms/:roomId/documents",
  asyncHandler(async (req, res) => {
    const who = await roomMember(req, res);
    if (!who) return;
    res.json({ documents: await listDocuments(who.roomId) });
  }),
);

documentsRouter.post(
  "/api/rooms/:roomId/documents",
  asyncHandler(async (req, res) => {
    const who = await roomMember(req, res);
    if (!who) return;
    const title = titleOf(z.object({ title: z.string().max(MAX_TITLE_CHARS * 2).optional() }).parse(req.body ?? {}).title) || "Untitled document";
    const doc = await createDocument(who.roomId, title, who.participantId);
    if (!doc) {
      res.status(409).json({ error: "too_many_documents", message: `A room holds up to ${MAX_DOCUMENTS_PER_ROOM} documents.` });
      return;
    }
    await announce(who.roomId);
    void touchSession(who.sessionId).catch(() => undefined);
    res.status(201).json({ document: doc });
  }),
);

/** Resolves the document and whether this person may rename or delete it. */
async function owned(req: Request, res: Response) {
  const who = await roomMember(req, res);
  if (!who) return null;
  const docId = routeParam(req, "docId");
  const doc = isDocId(docId) ? await getDocument(who.roomId, docId) : null;
  if (!doc) {
    res.status(404).json({ error: "not_found", message: "That document is no longer in this room." });
    return null;
  }
  if (doc.isMain) {
    res.status(400).json({ error: "main_document", message: "The room's notes can't be renamed or deleted." });
    return null;
  }
  if (doc.createdBy !== who.participantId && who.ownerId !== who.participantId) {
    res.status(403).json({ error: "not_allowed", message: "Only whoever made it, or the room's owner, can do that." });
    return null;
  }
  return { who, doc };
}

documentsRouter.patch(
  "/api/rooms/:roomId/documents/:docId",
  asyncHandler(async (req, res) => {
    const found = await owned(req, res);
    if (!found) return;
    const title = titleOf(z.object({ title: z.string().max(MAX_TITLE_CHARS * 2) }).parse(req.body ?? {}).title);
    if (!title) {
      res.status(400).json({ error: "invalid_title", message: "A document needs a name." });
      return;
    }
    await renameDocument(found.who.roomId, found.doc.id, title);
    await announce(found.who.roomId);
    res.json({ document: await getDocument(found.who.roomId, found.doc.id) });
  }),
);

documentsRouter.delete(
  "/api/rooms/:roomId/documents/:docId",
  asyncHandler(async (req, res) => {
    const found = await owned(req, res);
    if (!found) return;
    const key = docKey(found.who.roomId, found.doc.id);
    // Saved and released first, so a pending batch cannot land after the delete.
    await docHub.drop(key).catch(() => undefined);
    await deleteDocument(found.who.roomId, found.doc.id);
    await announce(found.who.roomId);
    res.status(204).end();
  }),
);

export { MAIN_DOC_ID };
