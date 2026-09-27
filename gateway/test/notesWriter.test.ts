import type { EnhancementJob, MediaItem } from "@rmcollab/shared";
import { findSection, NOTES_FIELD, SECTION_PLACEHOLDER } from "@rmcollab/shared/notes";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { ArtifactText } from "../src/db/repositories.js";
import { RoomDocHub } from "../src/docs/roomDocs.js";
import { NotesWriter, resultBlocks, sectionTitle } from "../src/notes/writer.js";

const ITEM: MediaItem = {
  id: "mi-1",
  roomId: "room-1",
  uploaderId: "p-1",
  uploaderName: "Alice",
  mediaType: "audio",
  originalFilename: "lecture.mp3",
  originalUrl: "/files/x",
  mimeType: "audio/mpeg",
  sizeBytes: 1,
  createdAt: 1,
};

const job = (o: Partial<EnhancementJob> = {}): EnhancementJob => ({
  id: "job-1",
  mediaItemId: "mi-1",
  mediaType: "audio",
  strategy: "comprehend",
  status: "done",
  progress: 1,
  message: null,
  artifacts: [],
  error: null,
  attemptCount: 1,
  createdAt: 1,
  startedAt: 1,
  completedAt: 2,
  ...o,
});

const SUMMARY: ArtifactText = {
  kind: "summary",
  mimeType: "text/markdown",
  body: "## Summary\nQueues.\n\n## Action items\n- Priya writes the report\n- Marcus reruns the benchmark",
  meta: {},
};
const TRANSCRIPT: ArtifactText = {
  kind: "transcript",
  mimeType: "text/plain",
  body: "[00:00:00] Welcome.\n[00:00:03] Today: queues.\n[00:00:09] Read chapter four.\n[00:00:12] Bye.",
  meta: { durationS: 15 },
};

/** The writer's editor, backed by one in-memory Y.Doc. */
function harness() {
  const doc = new Y.Doc();
  const writer = new NotesWriter({ edit: async (_room, change) => doc.transact(() => change(doc)) }, () => undefined);
  const notes = doc.getXmlFragment(NOTES_FIELD);
  const section = () => findSection(notes, "mi-1");
  const text = () => section()?.toString().replace(/<[^>]+>/g, "") ?? null;
  return { doc, writer, notes, section, text };
}

describe("NotesWriter", () => {
  it("adds one placeholder section per upload, however often it is told", async () => {
    const h = harness();
    await h.writer.uploaded(ITEM);
    await h.writer.uploaded(ITEM);
    expect(h.notes.length).toBe(1);
    expect(h.section()!.getAttribute("status")).toBe("processing");
    expect(h.section()!.getAttribute("title")).toBe("lecture.mp3");
    expect(h.text()).toBe(SECTION_PLACEHOLDER);
  });

  it("replaces the placeholder with the results, action items as a checklist", async () => {
    const h = harness();
    await h.writer.uploaded(ITEM);
    await h.writer.finished(ITEM, job(), [TRANSCRIPT, SUMMARY]);
    const section = h.section()!;
    expect(section.getAttribute("status")).toBe("done");
    expect(h.text()).not.toContain(SECTION_PLACEHOLDER);
    // toString lower-cases element names; the names themselves keep their case
    // (the client's schema contract test loads them into the real editor).
    const xml = section.toString();
    expect(xml.toLowerCase()).toContain("<tasklist>");
    expect(xml).toContain("Priya writes the report");
    expect(xml).toContain("Full transcript: 4 lines, 0:15");
  });

  it("puts results after anything a person typed, never over it", async () => {
    const h = harness();
    await h.writer.uploaded(ITEM);
    h.doc.transact(() => {
      const mine = new Y.XmlElement("paragraph");
      mine.insert(0, [new Y.XmlText("My notes on this")]);
      const section = h.section()!;
      section.delete(0, section.length);
      section.insert(0, [mine]);
    });
    await h.writer.finished(ITEM, job(), [SUMMARY]);
    expect(h.text()!.startsWith("My notes on this")).toBe(true);
    expect(h.text()).toContain("Priya writes the report");
  });

  it("does not undo a person deleting a section", async () => {
    const h = harness();
    await h.writer.uploaded(ITEM);
    h.doc.transact(() => h.notes.delete(0, 1));
    await h.writer.finished(ITEM, job(), [SUMMARY]);
    expect(h.notes.length).toBe(0);
  });

  it("still adds the results when a placeholder was never written", async () => {
    const h = harness();
    await h.writer.finished(ITEM, job(), [SUMMARY]);
    expect(h.section()!.getAttribute("status")).toBe("done");
  });

  it("ignores a redelivered completion", async () => {
    const h = harness();
    await h.writer.uploaded(ITEM);
    await h.writer.finished(ITEM, job(), [SUMMARY]);
    const once = h.section()!.toString();
    await h.writer.finished(ITEM, job(), [SUMMARY]);
    expect(h.section()!.toString()).toBe(once);
  });

  it("never lets a notes failure escape into the upload path", async () => {
    const writer = new NotesWriter({ edit: async () => { throw new Error("db down"); } }, () => undefined);
    await expect(writer.uploaded(ITEM)).resolves.toBeUndefined();
    await expect(writer.finished(ITEM, job(), [])).resolves.toBeUndefined();
  });
});

describe("resultBlocks", () => {
  const kinds = (blocks: ReturnType<typeof resultBlocks>) => blocks.map((b) => b.kind);

  it("without a summary, quotes the opening of the transcript", () => {
    const blocks = resultBlocks(job(), "audio", [TRANSCRIPT]);
    expect(kinds(blocks)).toEqual(["quote", "paragraph"]);
    expect(JSON.stringify(blocks[0])).toContain("Welcome. Today: queues. Read chapter four.");
    expect(JSON.stringify(blocks[0])).not.toContain("[00:00");
  });

  it("for rewritten text, puts the rewrite itself in the notes", () => {
    const blocks = resultBlocks(job({ strategy: "rewrite" }), "text", [
      { kind: "enhanced", mimeType: "text/plain", body: "First paragraph.\n\nSecond paragraph.", meta: {} },
    ]);
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
  });

  it("for an enhanced image, points to the comparison instead of dumping bytes", () => {
    const blocks = resultBlocks(job({ strategy: "realesrgan" }), "image", [
      { kind: "enhanced", mimeType: "image/png", body: null, meta: {} },
    ]);
    expect(JSON.stringify(blocks)).toContain("Enhanced with realesrgan");
  });

  it("says why a job failed", () => {
    const blocks = resultBlocks(job({ status: "failed", error: "no soundtrack" }), "video", []);
    expect(JSON.stringify(blocks)).toContain("could not be processed: no soundtrack");
  });

  it("names an upload without a filename by kind and person", () => {
    expect(sectionTitle({ ...ITEM, originalFilename: null, mediaType: "text" })).toBe("Text from Alice");
  });
});

describe("RoomDocHub.edit", () => {
  it("has saved the change by the time it returns, and lets go of a copy nobody is editing", async () => {
    const rows: Uint8Array[] = [];
    const hub = new RoomDocHub({
      store: { load: async () => [...rows], append: async (_r, u) => (rows.push(u), rows.length), compact: async () => 0 },
      publish: async () => undefined,
      flushMs: 10_000, // long enough that only edit()'s own flush can have saved it
      log: () => undefined,
    });
    await hub.edit("room-1", (doc) => doc.getText("t").insert(0, "placeholder"));
    expect(rows).toHaveLength(1);
    expect(hub.isLoaded("room-1")).toBe(false);
    const check = new Y.Doc();
    Y.applyUpdate(check, Y.mergeUpdates(rows));
    expect(check.getText("t").toString()).toBe("placeholder");
  });
});
