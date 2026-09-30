import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { titleFromText, type EnhanceTaskPayload, type MediaType } from "@rmcollab/shared";
import { Router, type Response } from "express";
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
import { touch } from "../../lifecycle.js";
import { checkUpload, type Refusal } from "../../limits.js";
import { notesWriter } from "../../notes/index.js";
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
import { resolveMediaType, sniffMedia } from "../sniff.js";
import { DEFAULT_STRATEGY, isKnownStrategy, routeJob } from "./strategies.js";

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

export function sendRefusal(res: Response, refusal: Refusal): void {
  if (refusal.retryAfterS) res.setHeader("Retry-After", String(refusal.retryAfterS));
  res.status(refusal.status).json({ error: refusal.error, message: refusal.message, retryAfterS: refusal.retryAfterS });
}

/**
 * The strategy options an upload may set. Everything else a strategy reads -
 * which model, which device, beam size, tile size - is the operator's to
 * configure, not a participant's: those decide what a job costs (a larger
 * Whisper model, a tiny tile on a long video), and some make a worker download
 * whatever it is told to. Unknown keys and out-of-range values are dropped.
 */
export function safeParams(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Clean the audio before transcribing it (comprehension), or not.
  if (typeof input["denoise"] === "boolean") out["denoise"] = input["denoise"];
  // The recording's language, when detection gets it wrong: an ISO 639-1/3 code.
  if (typeof input["language"] === "string" && /^[a-z]{2,3}$/.test(input["language"])) out["language"] = input["language"];
  return out;
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

    // Before anything is read or stored: the limits are about what this costs.
    const refusal = await checkUpload({
      participantId: participant.id,
      sessionId: room.sessionId,
      roomId: room.id,
      bytes: req.file?.size ?? Buffer.byteLength(parsed.data.text ?? "", "utf8"),
    });
    if (refusal) {
      sendRefusal(res, refusal);
      return;
    }

    const file = req.file;
    let mediaType: MediaType | null =
      parsed.data.mediaType ?? inferMediaType(file?.mimetype) ?? (text != null ? "text" : null);

    let buffer: Buffer;
    let originalFilename: string | null;
    let mimeType: string | null;
    // Set when the bytes contradict the claimed type: the extension then comes
    // from the content, not from a filename that was wrong.
    let sniffedExt: string | null = null;

    if (file) {
      // The file's own bytes decide which pool gets it, not the browser's label.
      const sniffed = sniffMedia(file.buffer);
      if (!sniffed) {
        res.status(415).json({
          error: "unsupported_media",
          message: "That file is not text, an image, a recording or a video that can be read.",
        });
        return;
      }
      const resolved = resolveMediaType(sniffed, mediaType);
      mediaType = resolved.mediaType;
      buffer = file.buffer;
      originalFilename = file.originalname || null;
      mimeType = resolved.overridden ? sniffed.mime : file.mimetype || sniffed.mime;
      if (resolved.overridden) sniffedExt = sniffed.ext;
    } else if (!mediaType) {
      res.status(400).json({ error: "unsupported_media", message: "Could not determine mediaType." });
      return;
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
          params = safeParams(decoded as Record<string, unknown>);
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
    const ext = sniffedExt ?? inferExtension(mediaType, originalFilename ?? undefined, mimeType ?? undefined);
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
      // Pasted text has no file name; its first words say more than "Text from Alice".
      title: !file && text ? titleFromText(text) : null,
    });
    if (!mediaItem) {
      res.status(500).json({ error: "media_insert_failed" });
      return;
    }

    const job = await insertJob({ mediaItemId, mediaType, strategy });
    // The upload's section in the room notes, saved before the job is queued,
    // so whichever replica handles its completion is guaranteed to find it.
    await notesWriter.uploaded(mediaItem);

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
      await enqueueEnhanceTask(payload, routeJob(payload.media_type, payload.strategy));
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
      if (failed) await notesWriter.finished(mediaItem, failed, []);
      res.status(502).json({ error: "enqueue_failed", message, mediaItem, job: failed ?? job });
      return;
    }

    touch(room.sessionId);
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

/**
 * One byte range from a Range header ("bytes=0-", "bytes=500-999", "bytes=-500").
 * Anything else - several ranges, other units, garbage - is served whole, which
 * is always a valid answer; a range starting past the end is unsatisfiable.
 */
export function byteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start: number;
  let end: number;
  if (match[1] === "") {
    // The last N bytes.
    const suffix = Number(match[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

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
    const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime);
    res.setHeader("Cache-Control", "public, max-age=60");
    // Uploads are other people's bytes: never sniffed into something runnable,
    // and inert even if opened directly.
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    // Ranges are what let a player seek: without them a browser can only seek
    // within what it has already downloaded, so a timestamp an hour into a
    // lecture would not play from there.
    res.setHeader("Accept-Ranges", "bytes");

    const range = byteRange(req.headers.range, info.size);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${info.size}`);
      res.status(416).end();
      return;
    }
    if (range) {
      res.status(206);
      res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${info.size}`);
      res.setHeader("Content-Length", String(range.end - range.start + 1));
    } else {
      res.setHeader("Content-Length", String(info.size));
    }
    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = createReadStream(absolute, range ? { start: range.start, end: range.end } : undefined);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  }),
);
