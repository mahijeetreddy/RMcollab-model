import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";
import type { JobEventArtifact, MediaType, Room, Session } from "@rmcollab/shared";
import { blockNode, NOTES_FIELD, paragraph, type NoteBlock } from "@rmcollab/shared/notes";
import { indexJob } from "./ask/indexer.js";
import {
  createRoom,
  createSession,
  getArtifactTexts,
  insertJob,
  insertMediaItem,
  setParticipantConnected,
  updateJobFromEvent,
  upsertParticipant,
} from "./db/repositories.js";
import { docHub } from "./docs/hub.js";
import { notesWriter } from "./notes/index.js";
import { originalPath, storage } from "./storage/local.js";

/**
 * "Try a sample room": a session already holding a study group's material -
 * a lecture recording, a whiteboard photo and a meeting note, each with the
 * results this app really produced for it (see demo/README.md) - so a visitor
 * sees what it does before they have anything of their own to add.
 *
 * Assembled from saved results, never by running jobs: opening one costs no
 * GPU time and no model quota. Its passages are embedded for Ask the room like
 * any other upload's. It expires like any session.
 */

const DEMO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../demo");
const GUIDE = "RMcollab sample";

interface DemoUpload {
  mediaType: MediaType;
  file: string;
  mimeType: string;
  originalFilename: string | null;
  title: string | null;
  strategy: string;
  artifacts: { file: string; kind: JobEventArtifact["kind"]; label: string; mimeType: string; meta?: Record<string, unknown> }[];
  message: string;
}

const UPLOADS: DemoUpload[] = [
  {
    mediaType: "text",
    file: "meeting.txt",
    mimeType: "text/plain",
    originalFilename: null,
    title: "Week 6 planning meeting",
    strategy: "rulebased",
    // Already clean, so the typo fixer leaves it as it is.
    artifacts: [{ file: "meeting.txt", kind: "enhanced", label: "Cleaned up", mimeType: "text/plain" }],
    message: "cleaned up with deterministic rules",
  },
  {
    mediaType: "audio",
    file: "lecture.mp3",
    mimeType: "audio/mpeg",
    originalFilename: "lecture.mp3",
    title: null,
    strategy: "comprehend",
    artifacts: [
      {
        file: "lecture-transcript.txt",
        kind: "transcript",
        label: "Transcript",
        mimeType: "text/plain",
        meta: { model: "small", language: "en", segments: 3, durationS: 14.93 },
      },
      { file: "lecture-summary.md", kind: "summary", label: "Summary", mimeType: "text/markdown", meta: { model: "openai/gpt-oss-120b" } },
    ],
    message: "transcribed 15 s and summarised",
  },
  {
    mediaType: "image",
    file: "whiteboard.jpg",
    mimeType: "image/jpeg",
    originalFilename: "whiteboard.jpg",
    title: null,
    strategy: "notes",
    artifacts: [{ file: "whiteboard-notes.md", kind: "summary", label: "Notes", mimeType: "text/markdown", meta: { model: "gemini-3.5-flash" } }],
    message: "read into notes",
  },
];

const text = (value: string) => [{ kind: "text" as const, text: value }];

/** The notes' opening: what this room is, and what to try. */
const INTRO: NoteBlock[] = [
  { kind: "heading", level: 2, content: text("Welcome to the sample room") },
  paragraph(
    "This is a study group's room with a lecture recording, a whiteboard photo and a meeting note already analysed below. " +
      "Everything here is yours to try: edit these notes (anyone else in the room sees it live), add your own files, " +
      "or open Ask the room and try:",
  ),
  {
    kind: "bullets",
    items: [
      text("Why did we pick Redis Streams over Kafka?"),
      text("Who owns which action item?"),
      text("When is the midterm, and is it open book?"),
    ],
  },
  paragraph("Sample rooms are deleted after 3 days without activity, like every session.", true),
];

export async function createDemo(): Promise<{ session: Session; rooms: Room[] }> {
  const session = await createSession("Sample: distributed systems study group");
  const room = await createRoom(session.id, "Main Room", true);
  const guide = await upsertParticipant({ sessionId: session.id, displayName: GUIDE });
  // Never online: it only authored the material, and must not keep the session alive.
  await setParticipantConnected(guide.id, false);

  for (const upload of UPLOADS) {
    const bytes = await readFile(path.join(DEMO_DIR, upload.file));
    const ext = path.extname(upload.file).slice(1);
    const id = nanoid(16);
    const inputPath = originalPath(room.id, id, ext);
    await storage.save(inputPath, bytes);
    const item = await insertMediaItem({
      id,
      roomId: room.id,
      uploaderId: guide.id,
      mediaType: upload.mediaType,
      originalFilename: upload.originalFilename,
      title: upload.title,
      storagePath: inputPath,
      mimeType: upload.mimeType,
      sizeBytes: bytes.byteLength,
    });
    if (!item) continue;

    const artifacts: JobEventArtifact[] = [];
    for (const artifact of upload.artifacts) {
      const target = `rooms/${room.id}/${item.id}/${artifact.file === upload.file ? `enhanced.${ext}` : artifact.file}`;
      await storage.save(target, await readFile(path.join(DEMO_DIR, artifact.file)));
      artifacts.push({ kind: artifact.kind, label: artifact.label, path: target, mimeType: artifact.mimeType, meta: artifact.meta ?? {} });
    }

    const job = await insertJob({ mediaItemId: item.id, mediaType: upload.mediaType, strategy: upload.strategy });
    await notesWriter.uploaded(item);
    const done = await updateJobFromEvent({
      jobId: job.id,
      mediaItemId: item.id,
      roomId: room.id,
      sessionId: session.id,
      mediaType: upload.mediaType,
      strategy: upload.strategy,
      status: "done",
      progress: 1,
      message: upload.message,
      artifacts,
      emittedAt: Date.now(),
    });
    if (done) {
      await notesWriter.finished(item, done, await getArtifactTexts(done.id));
      await indexJob(done.id);
    }
  }

  await docHub.edit(room.id, (doc) => {
    doc.getXmlFragment(NOTES_FIELD).insert(0, INTRO.map(blockNode));
  });
  return { session, rooms: [room] };
}
