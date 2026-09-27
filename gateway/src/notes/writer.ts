import type { EnhancementJob, MediaItem } from "@rmcollab/shared";
import {
  createSection,
  fillSection,
  findSection,
  NOTES_FIELD,
  paragraph,
  quote,
  summaryToBlocks,
  textToBlocks,
  type NoteBlock,
} from "@rmcollab/shared/notes";
import type * as Y from "yjs";
import type { ArtifactText } from "../db/repositories.js";

/**
 * Uploads writing into the room's notes.
 *
 * An upload gets a section the moment it is accepted - a placeholder the room
 * can see immediately - and the section is filled when the job finishes. Live
 * progress is deliberately NOT written into the document: it would be one CRDT
 * update and one stored row per progress tick, and it is already on every
 * client in the room's state. The section reads it from there.
 *
 * The writer only adds. An untouched placeholder is replaced; once anyone has
 * typed in a section, their words stay and the results go after them.
 */

/**
 * Uploads the writer has placed a section for, kept in the same CRDT document
 * (the editor binds only the notes fragment, so people never see it). It is
 * how "missing" is told apart: never written, versus deleted by a person - and
 * a person's deletion is a decision the writer must not undo.
 */
export const WRITTEN_SECTIONS = "notesWrittenSections";

export interface NotesEditor {
  edit(roomId: string, change: (doc: Y.Doc) => void): Promise<void>;
}

const LABEL: Record<string, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };

export function sectionTitle(item: MediaItem): string {
  return item.originalFilename ?? `${LABEL[item.mediaType] ?? "Upload"} from ${item.uploaderName}`;
}

const STAMP = /^\[\d+:\d{2}:\d{2}\]\s*/;

function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** What a finished job adds to its section. */
export function resultBlocks(job: EnhancementJob, mediaType: string, texts: ArtifactText[]): NoteBlock[] {
  if (job.status === "failed") {
    return [paragraph(`This upload could not be processed: ${job.error ?? "no reason was given"}.`, true)];
  }

  const blocks: NoteBlock[] = [];
  const summary = texts.find((t) => t.kind === "summary" && t.body);
  const transcript = texts.find((t) => t.kind === "transcript" && t.body);
  const enhanced = texts.find((t) => t.kind === "enhanced");

  if (summary?.body) blocks.push(...summaryToBlocks(summary.body));

  if (transcript?.body) {
    const lines = transcript.body
      .split(/\r?\n/)
      .map((line) => line.replace(STAMP, "").trim())
      .filter(Boolean);
    // Without a summary, the opening lines at least say what the recording is.
    if (!summary && lines.length > 0) blocks.push(quote(lines.slice(0, 3).join(" ")));
    const duration = typeof transcript.meta["durationS"] === "number" ? `, ${formatDuration(transcript.meta["durationS"])}` : "";
    blocks.push(
      paragraph(
        `Full transcript: ${lines.length} ${lines.length === 1 ? "line" : "lines"}${duration}, searchable in the Library.`,
        true,
      ),
    );
  }

  if (enhanced) {
    if (mediaType === "text" && enhanced.body) blocks.push(...textToBlocks(enhanced.body));
    else blocks.push(paragraph(`Enhanced with ${job.strategy}. Compare it with the original in the feed.`, true));
  }

  if (blocks.length === 0) blocks.push(paragraph(job.message ?? "Finished.", true));
  return blocks;
}

export class NotesWriter {
  constructor(
    private readonly editor: NotesEditor,
    private readonly log: (message: string, err?: unknown) => void = (m, e) => console.warn(`[notes] ${m}`, e ?? ""),
  ) {}

  /** A placeholder section for an upload that has just been accepted. */
  async uploaded(item: MediaItem): Promise<void> {
    try {
      await this.editor.edit(item.roomId, (doc) => {
        const notes = doc.getXmlFragment(NOTES_FIELD);
        const written = doc.getMap<number>(WRITTEN_SECTIONS);
        if (findSection(notes, item.id) || written.has(item.id)) return;
        written.set(item.id, Date.now());
        notes.insert(notes.length, [
          createSection(
            {
              mediaItemId: item.id,
              mediaType: item.mediaType,
              title: sectionTitle(item),
              author: item.uploaderName,
              createdAt: item.createdAt,
              status: "processing",
            },
            [],
          ),
        ]);
      });
    } catch (err) {
      // The notes are a view of the room's work, not part of accepting it: a
      // failure here must never fail the upload.
      this.log(`could not add a section for ${item.id}`, err);
    }
  }

  /** Fills an upload's section once its job has finished, either way. */
  async finished(item: MediaItem, job: EnhancementJob, texts: ArtifactText[]): Promise<void> {
    try {
      const blocks = resultBlocks(job, item.mediaType, texts);
      const status = job.status === "failed" ? "failed" : "done";
      await this.editor.edit(item.roomId, (doc) => {
        const notes = doc.getXmlFragment(NOTES_FIELD);
        const section = findSection(notes, item.id);
        if (section) {
          // A redelivered completion finds the section already done.
          if (section.getAttribute("status") === status) return;
          fillSection(section, blocks, status);
          return;
        }
        // Written once and now gone means someone deleted it: leave it gone.
        const written = doc.getMap<number>(WRITTEN_SECTIONS);
        if (written.has(item.id)) return;
        // Never written (the placeholder failed, or the upload predates the
        // notes): the results still belong in the room's notes.
        written.set(item.id, Date.now());
        notes.insert(notes.length, [
          createSection(
            {
              mediaItemId: item.id,
              mediaType: item.mediaType,
              title: sectionTitle(item),
              author: item.uploaderName,
              createdAt: item.createdAt,
              status,
            },
            blocks,
          ),
        ]);
      });
    } catch (err) {
      this.log(`could not fill the section for ${item.id}`, err);
    }
  }
}
