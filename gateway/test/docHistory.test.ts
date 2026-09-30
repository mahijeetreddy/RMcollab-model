import { NOTES_FIELD } from "@rmcollab/shared/notes";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { RoomDocHub, wordsIn } from "../src/docs/roomDocs.js";

/** When the notes get a restore point, with storage and history faked. */

function setup(options: { versionEveryMs?: number; latestAt?: number | null } = {}) {
  const rows: Uint8Array[] = [];
  const saved: { reason: string; state: Uint8Array; words: number }[] = [];
  let last: number | null = options.latestAt ?? null;
  const hub = new RoomDocHub({
    store: { load: async () => [...rows], append: async (_r, u) => (rows.push(u), rows.length), compact: async () => 0 },
    // Like the table: the latest point is whichever was saved last.
    history: {
      save: async (_roomId, state, reason, words) => {
        saved.push({ reason, state, words });
        last = Date.now();
      },
      latestAt: async () => last,
    },
    versionEveryMs: options.versionEveryMs ?? 60 * 60 * 1000,
    publish: async () => undefined,
    flushMs: 10_000,
    log: () => undefined,
  });
  return { hub, saved };
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement("paragraph");
  const t = new Y.XmlText();
  t.insert(0, text);
  p.insert(0, [t]);
  return p;
}

const LONG = "The group decided on Redis Streams because nobody wants to run ZooKeeper. ".repeat(12);
const textOf = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment(NOTES_FIELD).toString();
};

describe("notes restore points", () => {
  it("a room with no history gets one on its first save", async () => {
    const { hub, saved } = setup();
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph("hello")]));
    expect(saved.map((s) => s.reason)).toEqual(["Hourly"]);
  });

  it("keeps the notes as they were before most of them were deleted", async () => {
    const { hub, saved } = setup({ latestAt: Date.now() });
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph(LONG), paragraph("keep me")]));
    expect(saved).toEqual([]); // growing is not a reason to save
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).delete(0, 1));
    expect(saved.map((s) => s.reason)).toEqual(["Before a large deletion"]);
    // The copy kept is the one with the deleted text still in it.
    expect(textOf(saved[0]!.state)).toContain("Redis Streams");
    expect(saved[0]!.words).toBeGreaterThan(100);
  });

  it("an ordinary edit, or a small deletion, saves nothing", async () => {
    const { hub, saved } = setup({ latestAt: Date.now() });
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph(LONG), paragraph("a short line")]));
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).delete(1, 1));
    expect(saved).toEqual([]);
  });

  it("a second deletion is measured from after the first, not saved twice", async () => {
    const { hub, saved } = setup({ latestAt: Date.now() });
    await hub.edit("r", (doc) =>
      doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph(LONG), paragraph(LONG), paragraph(LONG), paragraph(LONG)]),
    );
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).delete(0, 3));
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).delete(0, 1));
    expect(saved.map((s) => s.reason)).toEqual(["Before a large deletion", "Before a large deletion"]);
    expect(saved[1]!.words).toBeLessThan(saved[0]!.words);
  });

  it("while a room is being edited, one comes round every hour", async () => {
    const { hub, saved } = setup({ latestAt: Date.now() - 2 * 60 * 60 * 1000, versionEveryMs: 60 * 60 * 1000 });
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph("an edit two hours after the last point")]));
    expect(saved.map((s) => s.reason)).toEqual(["Hourly"]);
    await hub.edit("r", (doc) => doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph("and another straight after")]));
    expect(saved).toHaveLength(1);
  });

  it("counts words in a saved state", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(NOTES_FIELD).insert(0, [paragraph("three short words")]);
    expect(wordsIn(Y.encodeStateAsUpdate(doc))).toBe(3);
  });
});
