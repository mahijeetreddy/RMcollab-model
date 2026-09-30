import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import { parseMarkdown } from "@rmcollab/shared";
import { createSection, NOTES_FIELD, summaryToBlocks, type SectionMeta } from "@rmcollab/shared/notes";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { exportFileName, notesToMarkdown } from "../src/features/notes/exportMarkdown";
import { schemaExtensions } from "../src/features/notes/schema";

const schema = getSchema(schemaExtensions());
const AT = new Date(2026, 8, 28);
const META: SectionMeta = {
  mediaItemId: "mi-1",
  mediaType: "audio",
  title: "lecture.mp3",
  author: "Alice",
  createdAt: new Date(2026, 8, 27).getTime(),
  status: "done",
};

const text = (value: string, marks: string[] = []) => ({ type: "text", text: value, marks: marks.map((type) => ({ type })) });
const p = (...content: object[]) => ({ type: "paragraph", content });
const doc = (...content: object[]) => schema.nodeFromJSON({ type: "doc", content });
const md = (...content: object[]) => notesToMarkdown(doc(...content), { roomName: "Main Room", at: AT });
/** The body alone, without the title and export lines. */
const body = (...content: object[]) => md(...content).split("\n\n").slice(2).join("\n\n").trim();

/** A notes document built by the gateway's writer and loaded as a browser would. */
function fromGateway(build: (fragment: Y.XmlFragment) => void) {
  const source = new Y.Doc();
  source.transact(() => build(source.getXmlFragment(NOTES_FIELD)));
  const browser = new Y.Doc();
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(source));
  return yXmlFragmentToProseMirrorRootNode(browser.getXmlFragment(NOTES_FIELD), schema);
}

describe("notes to Markdown", () => {
  it("opens with the room and the export date", () => {
    expect(md(p(text("hi")))).toMatch(/^# Main Room notes\n\n_Exported from RMcollab on 28 Sept? 2026_\n\nhi\n$/);
  });

  it("keeps inline formatting, with highlight and strike in their common syntax", () => {
    expect(
      body(
        p(
          text("bold", ["bold"]),
          text(" "),
          text("it", ["italic"]),
          text(" "),
          text("code", ["code"]),
          text(" "),
          text("gone", ["strike"]),
          text(" "),
          text("key", ["highlight"]),
          text(" "),
          text("under", ["underline"]),
        ),
      ),
    ).toBe("**bold** *it* `code` ~~gone~~ ==key== under");
  });

  it("writes headings, every list kind and a real checklist", () => {
    const out = body(
      { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }] },
      { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(text("three"))] }] },
      {
        type: "taskList",
        content: [
          { type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] },
          { type: "taskItem", attrs: { checked: false }, content: [p(text("todo"))] },
        ],
      },
    );
    expect(out).toBe(["## Plan", "- one", "3. three", "- [x] done\n- [ ] todo"].join("\n\n"));
  });

  it("escapes text that would otherwise read as Markdown", () => {
    expect(body(p(text("2 * 3 = 6 and _stress_")))).toBe("2 \\* 3 = 6 and \\_stress\\_");
    // Underscores inside a word never mean emphasis, so they stay as written.
    expect(body(p(text("job_artifacts")))).toBe("job_artifacts");
    expect(body(p(text("# not a heading")))).toBe("\\# not a heading");
  });

  it("fences code with its language, and quotes stay quotes", () => {
    const out = body(
      { type: "codeBlock", attrs: { language: "ts" }, content: [text("const a = 1;")] },
      { type: "blockquote", content: [p(text("said"))] },
    );
    expect(out).toBe("```ts\nconst a = 1;\n```\n\n> said");
  });

  it("turns an upload section the gateway wrote into a titled part, headings nested under it", () => {
    const node = fromGateway((f) =>
      f.insert(0, [createSection(META, summaryToBlocks("## Key points\n- Streams over Kafka\n\n## Action items\n- Priya drafts it"))]),
    );
    const out = notesToMarkdown(node, { roomName: "Main Room", at: AT });
    expect(out).toMatch(/## lecture\.mp3\n\n_Recording · Alice · 27 Sept? 2026_\n\n### Key points\n\n- Streams over Kafka\n\n### Action items\n\n- \[ \] Priya drafts it\n/);
  });

  it("leaves out a waiting section's placeholder, and says it was still processing", () => {
    const node = fromGateway((f) => f.insert(0, [createSection({ ...META, status: "processing" }, [])]));
    const out = notesToMarkdown(node, { roomName: "Main Room", at: AT });
    expect(out).toContain("still being processed_");
    expect(out).not.toContain("Analysing this upload");
  });

  it("reads back through the room's own Markdown parser as the same blocks", () => {
    const out = body(
      { type: "heading", attrs: { level: 2 }, content: [text("Decisions")] },
      p(text("We chose "), text("Redis Streams", ["bold"]), text(".")),
      { type: "bulletList", content: [{ type: "listItem", content: [p(text("no ZooKeeper"))] }] },
    );
    expect(parseMarkdown(out)).toEqual([
      // The parser's levels are relative: the shallowest heading is 1.
      { kind: "heading", level: 1, content: [{ kind: "text", text: "Decisions" }] },
      {
        kind: "paragraph",
        content: [
          { kind: "text", text: "We chose " },
          { kind: "strong", text: "Redis Streams" },
          { kind: "text", text: "." },
        ],
      },
      { kind: "list", ordered: false, items: [[{ kind: "text", text: "no ZooKeeper" }]] },
    ]);
  });

  it("adds transcripts as an appendix, one spoken line per line", () => {
    const out = notesToMarkdown(doc(p(text("notes"))), {
      roomName: "Main Room",
      at: AT,
      appendix: [{ title: "lecture.mp3", text: "[00:00:01] Welcome back\n[00:00:04] Today: *queues*\n" }],
    });
    expect(out).toContain("## Appendix: full transcripts\n\n### lecture.mp3\n\n\\[00:00:01\\] Welcome back  \n\\[00:00:04\\] Today: \\*queues\\*\n");
  });

  it("names the file after the room and the day", () => {
    expect(exportFileName("Main Room", AT)).toBe("main-room-notes-2026-09-28.md");
    expect(exportFileName("Études · Group A!", AT)).toBe("etudes-group-a-notes-2026-09-28.md");
    expect(exportFileName("***", AT)).toBe("room-notes-2026-09-28.md");
  });
});
