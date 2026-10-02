import path from "node:path";
import { MAX_TITLE_CHARS, type EnhanceTaskPayload, type MediaItem, type Participant, type Room } from "@rmcollab/shared";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  banFromRoom,
  deleteMediaItem,
  deleteRoom,
  getMediaItem,
  getParticipant,
  getRoom,
  hasRoomAccess,
  insertJob,
  latestJob,
  listRooms,
  mediaStoragePath,
  removeFromSession,
  rotateSessionCode,
  setMediaTitle,
  touchSession,
  updateJobFromEvent,
} from "../../db/repositories.js";
import { docHub } from "../../docs/hub.js";
import { checkUpload } from "../../limits.js";
import { notesWriter } from "../../notes/index.js";
import { submitJob } from "../../queue/dispatcher.js";
import { enhancedPath, mediaFolder, roomFolder, storage } from "../../storage/local.js";
import { pubsub } from "../../ws/pubsub.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";
import { sendRefusal } from "./media.js";
import { isKnownStrategy, routeJob } from "./strategies.js";

/**
 * Looking after a room's uploads, and the room itself: rename, retry, delete.
 *
 * Who may do what, with guest identity (a participant id is a bearer token):
 *   - rename or delete an upload: whoever uploaded it, or the room's owner
 *   - retry a failed upload: anyone in the room - it redoes work already asked for
 *   - delete a breakout room: its owner; the main room goes with its session
 */
export const manageRouter = Router();

const who = z.object({ participantId: z.string().trim().min(1).max(64) });

interface Context {
  room: Room;
  participant: Participant;
  item: MediaItem;
}

/** Resolves the room, the person and the upload, answering the request itself on any failure. */
async function context(req: Request, res: Response, participantId: string | undefined): Promise<Context | null> {
  const room = await getRoom(routeParam(req, "roomId"));
  const item = await getMediaItem(routeParam(req, "mediaItemId"));
  if (!room || !item || item.roomId !== room.id) {
    res.status(404).json({ error: "not_found", message: "That upload is no longer in this room." });
    return null;
  }
  const participant = participantId ? await getParticipant(participantId) : null;
  if (!participant || participant.sessionId !== room.sessionId || !(await hasRoomAccess(room.id, participant.id))) {
    res.status(403).json({ error: "not_in_room", message: "Join the room first." });
    return null;
  }
  return { room, participant, item };
}

const mayChange = ({ room, participant, item }: Context) =>
  item.uploaderId === participant.id || (room.ownerId !== null && room.ownerId === participant.id);

manageRouter.patch(
  "/api/rooms/:roomId/media/:mediaItemId",
  asyncHandler(async (req, res) => {
    const parsed = who.extend({ title: z.string().max(MAX_TITLE_CHARS * 2).nullable() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "participantId and title are required." });
      return;
    }
    const ctx = await context(req, res, parsed.data.participantId);
    if (!ctx) return;
    if (!mayChange(ctx)) {
      res.status(403).json({ error: "not_allowed", message: "Only whoever added it, or the room's owner, can rename it." });
      return;
    }
    // Control characters and runs of spaces go; an empty name means "use the file name".
    const title = (parsed.data.title ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
    const item = await setMediaTitle(ctx.item.id, title || null);
    if (!item) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    await notesWriter.renamed(item);
    await pubsub.publishToRoom(ctx.room.id, { type: "media_updated", roomId: ctx.room.id, mediaItem: item });
    void touchSession(ctx.room.sessionId).catch(() => undefined);
    res.json({ mediaItem: item });
  }),
);

manageRouter.post(
  "/api/rooms/:roomId/media/:mediaItemId/retry",
  asyncHandler(async (req, res) => {
    const parsed = who.extend({ strategy: z.string().trim().min(1).max(64).optional() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "participantId is required." });
      return;
    }
    const ctx = await context(req, res, parsed.data.participantId);
    if (!ctx) return;
    const previous = await latestJob(ctx.item.id);
    if (!previous || previous.status !== "failed") {
      res.status(409).json({ error: "not_failed", message: "Only an upload that failed can be retried." });
      return;
    }
    // A retry spends the same GPU or model time as an upload.
    const refusal = await checkUpload({
      participantId: ctx.participant.id,
      sessionId: ctx.room.sessionId,
      roomId: ctx.room.id,
      bytes: 0,
    });
    if (refusal) {
      sendRefusal(res, refusal);
      return;
    }
    const inputPath = await mediaStoragePath(ctx.item.id);
    if (!inputPath) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const mediaType = ctx.item.mediaType;
    const requested = parsed.data.strategy;
    const strategy = requested && isKnownStrategy(mediaType, requested) ? requested : previous.strategy;
    const ext = path.extname(inputPath).slice(1) || "bin";
    const job = await insertJob({ mediaItemId: ctx.item.id, mediaType, strategy });
    await notesWriter.retrying(ctx.item);

    const payload: EnhanceTaskPayload = {
      job_id: job.id,
      media_item_id: ctx.item.id,
      room_id: ctx.room.id,
      session_id: ctx.room.sessionId,
      media_type: mediaType,
      strategy,
      input_path: inputPath,
      output_path: enhancedPath(ctx.room.id, ctx.item.id, ext),
      params: {},
    };
    try {
      await submitJob(job.id, payload, routeJob(mediaType, strategy));
    } catch (err) {
      const message = err instanceof Error ? err.message : "enqueue failed";
      const failed = await updateJobFromEvent({
        jobId: job.id,
        mediaItemId: ctx.item.id,
        roomId: ctx.room.id,
        sessionId: ctx.room.sessionId,
        mediaType,
        strategy,
        status: "failed",
        progress: 0,
        error: message,
        emittedAt: Date.now(),
      });
      if (failed) await notesWriter.finished(ctx.item, failed, []);
      res.status(502).json({ error: "enqueue_failed", message });
      return;
    }
    await pubsub.publishToRoom(ctx.room.id, { type: "media_updated", roomId: ctx.room.id, mediaItem: ctx.item, job });
    void touchSession(ctx.room.sessionId).catch(() => undefined);
    res.status(201).json({ mediaItem: ctx.item, job });
  }),
);

manageRouter.delete(
  "/api/rooms/:roomId/media/:mediaItemId",
  asyncHandler(async (req, res) => {
    const participantId = typeof req.query["participantId"] === "string" ? req.query["participantId"] : undefined;
    const ctx = await context(req, res, participantId);
    if (!ctx) return;
    if (!mayChange(ctx)) {
      res.status(403).json({ error: "not_allowed", message: "Only whoever added it, or the room's owner, can delete it." });
      return;
    }
    // The row first: once it is gone nothing can serve or index the upload,
    // and a job still running finds its record missing and is ignored.
    await deleteMediaItem(ctx.item.id);
    await storage.removeTree(mediaFolder(ctx.room.id, ctx.item.id)).catch((err: unknown) =>
      console.warn("[manage] could not remove files for", ctx.item.id, err),
    );
    await notesWriter.removed(ctx.room.id, ctx.item.id);
    await pubsub.publishToRoom(ctx.room.id, { type: "media_deleted", roomId: ctx.room.id, mediaItemId: ctx.item.id });
    void touchSession(ctx.room.sessionId).catch(() => undefined);
    res.status(204).end();
  }),
);

manageRouter.post(
  "/api/rooms/:roomId/participants/:targetId/remove",
  asyncHandler(async (req, res) => {
    const parsed = who.safeParse(req.body ?? {});
    const room = await getRoom(routeParam(req, "roomId"));
    const targetId = routeParam(req, "targetId");
    if (!parsed.success || !room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const owner = await getParticipant(parsed.data.participantId);
    if (!owner || room.ownerId !== owner.id) {
      res.status(403).json({ error: "not_room_owner", message: "Only the room's owner can remove people from it." });
      return;
    }
    const target = await getParticipant(targetId);
    if (!target || target.sessionId !== room.sessionId) {
      res.status(404).json({ error: "not_found", message: "They are no longer in this session." });
      return;
    }
    if (target.id === owner.id) {
      res.status(400).json({ error: "cannot_remove_self", message: "You can't remove yourself." });
      return;
    }

    if (room.isMain) {
      // Out of the main room is out of the session.
      await removeFromSession(target.id);
      await pubsub.publishToSession(room.sessionId, {
        type: "participant_removed",
        roomId: room.id,
        participantId: target.id,
        scope: "session",
        byName: owner.displayName,
      });
      // The code they know stops working for anyone new; members are unaffected.
      const session = await rotateSessionCode(room.sessionId);
      if (session) {
        await pubsub.publishToSession(room.sessionId, { type: "session_updated", session });
        res.json({ newCode: session.code });
        return;
      }
    } else {
      await banFromRoom(room.id, target.id);
      await pubsub.publishToRoom(room.id, {
        type: "participant_removed",
        roomId: room.id,
        participantId: target.id,
        scope: "room",
        byName: owner.displayName,
      });
    }
    res.status(204).end();
  }),
);

manageRouter.delete(
  "/api/rooms/:roomId",
  asyncHandler(async (req, res) => {
    const participantId = typeof req.query["participantId"] === "string" ? req.query["participantId"] : "";
    const room = await getRoom(routeParam(req, "roomId"));
    if (!room) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (room.isMain) {
      res.status(400).json({ error: "main_room", message: "The main room goes when its session does." });
      return;
    }
    if (!participantId || room.ownerId !== participantId) {
      res.status(403).json({ error: "not_room_owner", message: "Only the person who made this room can delete it." });
      return;
    }
    // Told first, while they can still hear it: everyone inside moves to the main room.
    await pubsub.publishToRoom(room.id, { type: "room_deleted", roomId: room.id });
    await docHub.dropAll(room.id).catch(() => undefined);
    await deleteRoom(room.id);
    await storage.removeTree(roomFolder(room.id)).catch((err: unknown) =>
      console.warn("[manage] could not remove files for room", room.id, err),
    );
    await pubsub.publishToSession(room.sessionId, {
      type: "rooms_updated",
      sessionId: room.sessionId,
      rooms: await listRooms(room.sessionId),
    });
    void touchSession(room.sessionId).catch(() => undefined);
    res.status(204).end();
  }),
);
