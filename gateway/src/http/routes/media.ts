import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { EnhanceTaskPayload, MediaType } from "@rmcollab/shared";
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import { z } from "zod";
import { config } from "../../config.js";
import {
  getParticipant,
  getRoom,
  insertJob,
  insertMediaItem,
  updateJobFromEvent,
  hasRoomAccess,} from "../../db/repositories.js";
import { enqueueEnhanceTask } from "../../queue/enqueue.js";
import {
  enhancedPath,
  originalPath,
  storage,
  verifyFileSignature,
} from "../../storage/local.js";
import { pubsub } from "../../ws/pubsub.js";
import { asyncHandler } from "../asyncHandler.js";
import { routeParam } from "../params.js";
import { DEFAULT_STRATEGY, isKnownStrategy } from "./strategies.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

const bodySchema = z.object({
  participantId: z.string().trim().min(1).max(64),
  mediaType: z.enum(["text", "image", "audio", "video"]).optional(),
  strategy: z.string().trim().min(1).max(64).optional(),
  text: z.string().max(200_000).optional(),
  params: z.string().optional(),
});

const EXTENSIONS: Record<string, string> = {
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/ogg": "ogg",
  "audio/webm": "weba",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXTENSIONS).map(([mime, ext]) => [ext, mime]),
);

const DEFAULT_EXT: Record<MediaType, string> = {
  text: "txt",
  image: "png",
  audio: "mp3",
  video: "mp4",
};

function inferMediaType(mimeType: string | undefined): MediaType | null {
  if (!mimeType) return null;
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("text/") || mimeType === "application/json") return "text";
  return null;
}

function inferExtension(
  mediaType: MediaType,
  filename: string | undefined,
  mimeType: string | undefined,
): string {
  const fromName = filename ? path.extname(filename).slice(1).toLowerCase() : "";
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  if (mimeType && EXTENSIONS[mimeType]) return EXTENSIONS[mimeType]!;
  return DEFAULT_EXT[mediaType];
}

export const mediaRouter = Router();

mediaRouter.post(
  "/api/rooms/:roomId/media",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const room = await getRoom(routeParam(req, "roomId"));
    if (!room) {
      res.status(404).json({ error: "room_not_found" });
      return;
    }

    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body", message: "participantId is required." });
      return;
    }
    const { participantId, strategy: requestedStrategy, text } = parsed.data;

    const participant = await getParticipant(participantId);
    if (!participant || participant.sessionId !== room.sessionId) {
      res.status(403).json({ error: "participant_not_in_session" });
      return;
    }
    // Being in the session is not enough to upload into a locked breakout.
    if (!(await hasRoomAccess(room.id, participant.id))) {
      res.status(403).json({
        error: "room_locked",
        message: "You do not have access to this room.",
      });
      return;
    }

    const file = req.file;
    const mediaType =
      parsed.data.mediaType ?? inferMediaType(file?.mimetype) ?? (text != null ? "text" : null);
    if (!mediaType) {
      res.status(400).json({ error: "unsupported_media", message: "Could not determine mediaType." });
      return;
    }

    let buffer: Buffer;
    let originalFilename: string | null;
    let mimeType: string | null;

    if (file) {
      buffer = file.buffer;
      originalFilename = file.originalname || null;
      mimeType = file.mimetype || null;
    } else if (mediaType === "text" && text && text.trim().length > 0) {
      buffer = Buffer.from(text, "utf8");
      originalFilename = null;
      mimeType = "text/plain";
    } else {
      res.status(400).json({ error: "missing_payload", message: "Provide a file or text body." });
      return;
    }

    let params: Record<string, unknown> = {};
    if (parsed.data.params) {
      try {
        const decoded: unknown = JSON.parse(parsed.data.params);
        if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
          params = decoded as Record<string, unknown>;
        }
      } catch {
        res.status(400).json({ error: "invalid_params", message: "params must be JSON." });
        return;
      }
    }

    const strategy =
      requestedStrategy && isKnownStrategy(mediaType, requestedStrategy)
        ? requestedStrategy
        : DEFAULT_STRATEGY;

    const mediaItemId = nanoid(16);
    const ext = inferExtension(mediaType, originalFilename ?? undefined, mimeType ?? undefined);
    const inputPath = originalPath(room.id, mediaItemId, ext);
    const outputPath = enhancedPath(room.id, mediaItemId, ext);

    await storage.save(inputPath, buffer);

    const mediaItem = await insertMediaItem({
      id: mediaItemId,
      roomId: room.id,
      uploaderId: participant.id,
      mediaType,
      originalFilename,
      storagePath: inputPath,
      mimeType,
      sizeBytes: buffer.byteLength,
    });
    if (!mediaItem) {
      res.status(500).json({ error: "media_insert_failed" });
      return;
    }

    const job = await insertJob({ mediaItemId, mediaType, strategy });

    const payload: EnhanceTaskPayload = {
      job_id: job.id,
      media_item_id: mediaItem.id,
      room_id: room.id,
      session_id: room.sessionId,
      media_type: mediaType,
      strategy,
      input_path: inputPath,
      output_path: outputPath,
      params,
    };

    try {
      await enqueueEnhanceTask(payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : "enqueue failed";
      const failed = await updateJobFromEvent({
        jobId: job.id,
        mediaItemId: mediaItem.id,
        roomId: room.id,
        sessionId: room.sessionId,
        mediaType,
        strategy,
        status: "failed",
        progress: 0,
        error: message,
        emittedAt: Date.now(),
      });
      res.status(502).json({ error: "enqueue_failed", message, mediaItem, job: failed ?? job });
      return;
    }

    await pubsub.publishToRoom(room.id, {
      type: "media_uploaded",
      roomId: room.id,
      mediaItem,
      job,
    });
    res.status(201).json({ mediaItem, job });
  }),
);

export const filesRouter = Router();

filesRouter.get(
  "/files/*",
  asyncHandler(async (req, res) => {
    const relPath = decodeURIComponent(String(req.params[0] ?? ""));

    const signature = verifyFileSignature(
      relPath.replace(/\\/g, "/").replace(/^\/+/, ""),
      typeof req.query["exp"] === "string" ? req.query["exp"] : undefined,
      typeof req.query["sig"] === "string" ? req.query["sig"] : undefined,
    );
    if (!signature.ok) {
      res.status(403).json({
        error: signature.reason === "expired" ? "link_expired" : "invalid_signature",
        message:
          signature.reason === "expired"
            ? "This media link has expired; reload the room to get a fresh one."
            : "This media link is not valid for this file.",
      });
      return;
    }

    let absolute: string;
    try {
      absolute = storage.resolve(relPath);
    } catch {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    let info;
    try {
      info = await stat(absolute);
    } catch {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!info.isFile()) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const ext = path.extname(absolute).slice(1).toLowerCase();
    res.setHeader("Content-Type", MIME_BY_EXT[ext] ?? "application/octet-stream");
    res.setHeader("Content-Length", String(info.size));
    res.setHeader("Cache-Control", "public, max-age=60");

    const stream = createReadStream(absolute);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }),
);
