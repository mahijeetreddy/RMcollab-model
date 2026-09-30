import { docKey, isDocId, NOTES_FIELD, notesSections } from "@rmcollab/shared/notes";
import { Router, type Request, type Response } from "express";
import * as Y from "yjs";
import { getParticipant, getRoom, hasRoomAccess } from "../../db/repositories.js";
import { getDocument, getRoomDocVersion, listRoomDocVersions, saveRoomDocVersion } from "../../db/roomDocs.js";
import { wordsIn } from "../../docs/roomDocs.js";
import { docHub } from "../../docs/hub.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";

/**
 * The notes' version history: list restore points, preview one, restore it.
 *
 * Anyone in the room may restore, as anyone may edit - and a restore is itself
 * undoable, because the notes as they were just before it are saved first.
 * Restoring is an edit like any other: every open editor sees it arrive live.
 */
export const versionsRouter = Router();

const PREVIEW_CHARS = 600;

async function member(req: Request, res: Response): Promise<{ roomId: string; key: string; name: string } | null> {
  const room = await getRoom(routeParam(req, "roomId"));
  const participantId =
    (typeof req.query["participantId"] === "string" ? req.query["participantId"] : undefined) ??
    (typeof req.body?.participantId === "string" ? (req.body.participantId as string) : undefined);
  const participant = participantId ? await getParticipant(participantId) : null;
  if (!room || !participant || participant.sessionId !== room.sessionId || !(await hasRoomAccess(room.id, participant.id))) {
    res.status(403).json({ error: "not_in_room", message: "Join the room first." });
    return null;
  }
  const docId = routeParam(req, "docId");
  if (!isDocId(docId) || !(await getDocument(room.id, docId))) {
    res.status(404).json({ error: "not_found", message: "That document is no longer in this room." });
    return null;
  }
  return { roomId: room.id, key: docKey(room.id, docId), name: participant.displayName };
}

versionsRouter.get(
  "/api/rooms/:roomId/documents/:docId/versions",
  asyncHandler(async (req, res) => {
    const who = await member(req, res);
    if (!who) return;
    res.json({ versions: await listRoomDocVersions(who.key) });
  }),
);

versionsRouter.get(
  "/api/rooms/:roomId/documents/:docId/versions/:versionId",
  asyncHandler(async (req, res) => {
    const who = await member(req, res);
    if (!who) return;
    const version = await getRoomDocVersion(who.key, routeParam(req, "versionId"));
    if (!version) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, version.state);
    // A preview in words, section by section: what someone needs to recognise
    // the version they are looking for.
    const sections = notesSections(doc.getXmlFragment(NOTES_FIELD)).map((s) => ({
      title: s.title,
      text: s.text.length > PREVIEW_CHARS ? `${s.text.slice(0, PREVIEW_CHARS).replace(/\s+\S*$/, "")}…` : s.text,
    }));
    doc.destroy();
    const { state: _state, ...meta } = version;
    res.json({ version: meta, sections });
  }),
);

versionsRouter.post(
  "/api/rooms/:roomId/documents/:docId/versions/:versionId/restore",
  asyncHandler(async (req, res) => {
    const who = await member(req, res);
    if (!who) return;
    const version = await getRoomDocVersion(who.key, routeParam(req, "versionId"));
    if (!version) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const old = new Y.Doc();
    Y.applyUpdate(old, version.state);
    const content = old
      .getXmlFragment(NOTES_FIELD)
      .toArray()
      .map((node) => (node as Y.XmlElement | Y.XmlText).clone());
    // What is there now is captured inside the same edit, so the restore can be
    // undone the same way. Not through docHub.document(): that would leave a
    // copy open on a replica that may not be hearing the room's edits, and the
    // next person to join through it would be handed a stale document.
    const before: { state?: Uint8Array } = {};
    await docHub.edit(who.key, (doc) => {
      before.state = Y.encodeStateAsUpdate(doc);
      const notes = doc.getXmlFragment(NOTES_FIELD);
      notes.delete(0, notes.length);
      notes.insert(0, content);
    });
    old.destroy();
    if (before.state) {
      await saveRoomDocVersion(who.key, before.state, `Before ${who.name} restored an earlier version`, wordsIn(before.state));
    }
    res.json({ restored: version.id });
  }),
);
