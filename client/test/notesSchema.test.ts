import { getSchema } from "@tiptap/core";
import { yXmlFragmentToProseMirrorRootNode } from "@tiptap/y-tiptap";
import {
  createSection,
  fillSection,
  findSection,
  isPlaceholder,
  NOTES_FIELD,
  paragraph,
  quote,
  SECTION_NODE,
  SECTION_PLACEHOLDER,
  summaryToBlocks,
  textToBlocks,
  type NoteBlock,
  type SectionMeta,
} from "@rmcollab/shared/notes";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { schemaExtensions } from "../src/features/notes/schema";

/**
 * The contract between the gateway, which writes sections into a room's notes,
 * and the editor, which renders them. The editor's collaboration binding does
 * not show an invalid node - it deletes it - so a drift here would make the
 * AI's contributions silently vanish from everyone's notes. These tests build
 * with the gateway's code and load with the editor's real schema.
 */

const schema = getSchema(schemaExtensions());

const META: SectionMeta = {
  mediaItemId: "mi-1",
  mediaType: "audio",
  title: "lecture.mp3",
  author: "Alice",
  createdAt: 1_700_000_000_000,
  status: "processing",
};

const SUMMARY = [
  "## Summary",
  "The lecture covered **queues** and `XAUTOCLAIM`.",
  "",
  "## Key points",
  "- Gateways are stateless",
  "- Workers pull from Redis",
  "",
  "## Action items",
  "- Priya writes the *consumer groups* section by Friday",
  "- Marcus reruns the benchmark",
  "",
  "## Steps",
  "1. Read chapter 3",
  "2. Try the demo",
].join("\n");

/** Builds a notes document with the gateway's code and loads it as the editor would. */
function load(build: (fragment: Y.XmlFragment) => void) {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment(NOTES_FIELD);
  doc.transact(() => build(fragment));
  // Loaded through a fresh doc, as a browser receiving the update would.
  const browser = new Y.Doc();
  Y.applyUpdate(browser, Y.encodeStateAsUpdate(doc));
  const browserFragment = browser.getXmlFragment(NOTES_FIELD);
  const before = browserFragment.length;
  const node = yXmlFragmentToProseMirrorRootNode(browserFragment, schema);
  return { node, before, after: browserFragment.length, fragment, doc };
}

describe("sections the gateway writes load in the editor's schema", () => {
  it("a placeholder section loads intact, with every attribute", () => {
    const { node, before, after } = load((f) => f.insert(0, [createSection(META, [])]));
    expect(after).toBe(before); // nothing deleted as invalid
    const section = node.firstChild!;
    expect(section.type.name).toBe(SECTION_NODE);
    expect(section.attrs).toMatchObject({ mediaItemId: "mi-1", title: "lecture.mp3", author: "Alice", status: "processing" });
    expect(section.textContent).toBe(SECTION_PLACEHOLDER);
  });

  it("a summary loads as headings, lists and a real checklist, with formatting", () => {
    const { node, after, before } = load((f) => f.insert(0, [createSection({ ...META, status: "done" }, summaryToBlocks(SUMMARY))]));
    expect(after).toBe(before);
    const section = node.firstChild!;
    const types: string[] = [];
    section.forEach((child) => types.push(child.type.name));
    expect(types).toEqual(["heading", "paragraph", "heading", "bulletList", "heading", "taskList", "heading", "orderedList"]);

    const tasks = section.child(5);
    expect(tasks.childCount).toBe(2);
    expect(tasks.firstChild!.attrs["checked"]).toBe(false);
    expect(tasks.firstChild!.textContent).toBe("Priya writes the consumer groups section by Friday");

    const marks = new Set<string>();
    section.descendants((n) => {
      n.marks.forEach((m) => marks.add(m.type.name));
    });
    expect([...marks].sort()).toEqual(["bold", "code", "italic"]);
    expect(section.child(0).attrs["level"]).toBe(3);
  });

  it("every block kind the writer can produce is valid", () => {
    const all: NoteBlock[] = [
      { kind: "heading", level: 2, content: [{ kind: "text", text: "H2" }] },
      paragraph("plain"),
      paragraph("emphasised", true),
      quote("opening lines"),
      { kind: "bullets", items: [[{ kind: "text", text: "a" }]] },
      { kind: "numbers", items: [[{ kind: "text", text: "b" }]] },
      { kind: "tasks", items: [{ content: [{ kind: "text", text: "c" }], checked: true }] },
      ...textToBlocks("one\n\ntwo"),
    ];
    const { node, before, after } = load((f) => f.insert(0, [createSection(META, all)]));
    expect(after).toBe(before);
    expect(node.firstChild!.childCount).toBe(all.length);
  });

  it("sections sit beside what people wrote, and nothing is dropped", () => {
    const { node, before, after } = load((f) => {
      const heading = new Y.XmlElement("heading");
      heading.setAttribute("level", 1 as unknown as string);
      heading.insert(0, [new Y.XmlText("Our notes")]);
      f.insert(0, [heading, createSection(META, []), createSection({ ...META, mediaItemId: "mi-2" }, [])]);
    });
    expect(after).toBe(before);
    expect(node.childCount).toBe(3);
  });
});

describe("filling a section", () => {
  it("replaces an untouched placeholder", () => {
    const { fragment, doc } = load((f) => f.insert(0, [createSection(META, [])]));
    let outcome = "";
    doc.transact(() => {
      outcome = fillSection(findSection(fragment, "mi-1")!, summaryToBlocks(SUMMARY), "done");
    });
    expect(outcome).toBe("replaced");
    const section = findSection(fragment, "mi-1")!;
    expect(section.getAttribute("status")).toBe("done");
    expect(isPlaceholder(section)).toBe(false);
    expect(yXmlFragmentToProseMirrorRootNode(fragment, schema).firstChild!.textContent).not.toContain(SECTION_PLACEHOLDER);
  });

  it("never overwrites what a person typed: results go after it", () => {
    const { fragment, doc } = load((f) => f.insert(0, [createSection(META, [])]));
    // Someone replaces the placeholder with their own note before the job ends.
    doc.transact(() => {
      const section = findSection(fragment, "mi-1")!;
      const mine = new Y.XmlElement("paragraph");
      mine.insert(0, [new Y.XmlText("My own take on this lecture")]);
      section.delete(0, section.length);
      section.insert(0, [mine]);
    });
    let outcome = "";
    doc.transact(() => {
      outcome = fillSection(findSection(fragment, "mi-1")!, [paragraph("The summary")], "done");
    });
    expect(outcome).toBe("appended");
    const text = yXmlFragmentToProseMirrorRootNode(fragment, schema).firstChild!.textContent;
    expect(text).toBe("My own take on this lectureThe summary");
  });

  it("finds a section by its upload, and nothing for an unknown one", () => {
    const { fragment } = load((f) => f.insert(0, [createSection(META, [])]));
    expect(findSection(fragment, "mi-1")).not.toBeNull();
    expect(findSection(fragment, "missing")).toBeNull();
  });
});

describe("textToBlocks", () => {
  it("keeps paragraphs and marks a clipped result as continuing elsewhere", () => {
    const blocks = textToBlocks(`${"word ".repeat(1200)}\n\nlast`, 200);
    const last = blocks[blocks.length - 1]!;
    expect(last.kind).toBe("paragraph");
    expect(JSON.stringify(last)).toContain("Continues in the full result");
    expect(JSON.stringify(blocks)).not.toContain("last");
  });
});
