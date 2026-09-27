import * as Y from "yjs";
import { parseMarkdown, type Block, type Inline } from "./markdown.js";

/**
 * Writing into a room's notes from outside the editor - the gateway adding what
 * an upload produced.
 *
 * The notes are a Yjs XmlFragment that TipTap's collaboration binding maps to
 * ProseMirror nodes by name. That makes the node names, attributes and nesting
 * here a contract with the editor's schema: an element the schema rejects is
 * not shown with an error, it is *deleted* by the first browser that loads it.
 * client/test/notesSchema.test.ts loads everything built here into the real
 * editor schema and fails if anything would be dropped.
 *
 * Its own entry point (`@rmcollab/shared/notes`) so the client's main bundle,
 * which imports the package root for constants, never pulls in Yjs.
 */

/** The fragment name the editor binds to. */
export const NOTES_FIELD = "notes";
/** A block container holding everything one upload contributed. */
export const SECTION_NODE = "uploadSection";
/** What an upload's section says until its analysis lands. */
export const SECTION_PLACEHOLDER = "Analysing this upload. Its summary will appear here.";

export type SectionStatus = "processing" | "done" | "failed";

export interface SectionMeta {
  mediaItemId: string;
  mediaType: string;
  title: string;
  author: string;
  createdAt: number;
  status: SectionStatus;
}

export type NoteBlock =
  | { kind: "heading"; level: 2 | 3; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "bullets"; items: Inline[][] }
  | { kind: "numbers"; items: Inline[][] }
  | { kind: "tasks"; items: { content: Inline[]; checked: boolean }[] }
  | { kind: "quote"; content: Inline[] };

const text = (value: string): Inline[] => [{ kind: "text", text: value }];

// --- from analysis results to blocks ---------------------------------------------

const ACTION_HEADING = /^(action items?|next steps|to ?dos?|tasks)$/i;

/**
 * A model-written summary as note blocks. Headings sit one level below the
 * section, and the list under an "Action items" heading becomes a real
 * checklist - the part of a summary a group actually works through.
 */
export function summaryToBlocks(markdown: string): NoteBlock[] {
  const blocks: NoteBlock[] = [];
  let underActions = false;
  for (const block of parseMarkdown(markdown) as Block[]) {
    if (block.kind === "heading") {
      const title = block.content.map((part) => part.text).join("").trim();
      underActions = ACTION_HEADING.test(title);
      blocks.push({ kind: "heading", level: 3, content: block.content });
    } else if (block.kind === "list") {
      if (underActions) {
        blocks.push({ kind: "tasks", items: block.items.map((content) => ({ content, checked: false })) });
      } else {
        blocks.push({ kind: block.ordered ? "numbers" : "bullets", items: block.items });
      }
    } else {
      blocks.push({ kind: "paragraph", content: block.content });
    }
  }
  return blocks;
}

/** Plain text as paragraphs, cut at a length that keeps the notes readable. */
export function textToBlocks(value: string, maxChars = 4000): NoteBlock[] {
  const clipped = value.length > maxChars;
  const body = clipped ? value.slice(0, value.lastIndexOf(" ", maxChars) > 0 ? value.lastIndexOf(" ", maxChars) : maxChars) : value;
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").trim())
    .filter(Boolean)
    .map((p): NoteBlock => ({ kind: "paragraph", content: text(p) }));
  if (clipped) {
    paragraphs.push({ kind: "paragraph", content: [{ kind: "em", text: "Continues in the full result in the feed." }] });
  }
  return paragraphs;
}

export function paragraph(value: string, emphasis = false): NoteBlock {
  return { kind: "paragraph", content: [{ kind: emphasis ? "em" : "text", text: value }] };
}

export function quote(value: string): NoteBlock {
  return { kind: "quote", content: text(value) };
}

// --- blocks to the editor's XML ----------------------------------------------------

const MARK: Record<Inline["kind"], Record<string, object> | undefined> = {
  text: undefined,
  strong: { bold: {} },
  em: { italic: {} },
  code: { code: {} },
};

function textNode(content: Inline[]): Y.XmlText {
  const node = new Y.XmlText();
  const delta = content
    .filter((part) => part.text.length > 0)
    .map((part) => (MARK[part.kind] ? { insert: part.text, attributes: MARK[part.kind] } : { insert: part.text }));
  if (delta.length > 0) node.applyDelta(delta);
  return node;
}

function element(name: string, children: (Y.XmlElement | Y.XmlText)[], attrs: Record<string, unknown> = {}): Y.XmlElement {
  const node = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value as string);
  }
  if (children.length > 0) node.insert(0, children);
  return node;
}

const paragraphNode = (content: Inline[]) => element("paragraph", [textNode(content)]);

function blockNode(block: NoteBlock): Y.XmlElement {
  switch (block.kind) {
    case "heading":
      return element("heading", [textNode(block.content)], { level: block.level });
    case "paragraph":
      return paragraphNode(block.content);
    case "quote":
      return element("blockquote", [paragraphNode(block.content)]);
    case "bullets":
      return element("bulletList", block.items.map((item) => element("listItem", [paragraphNode(item)])));
    case "numbers":
      return element(
        "orderedList",
        block.items.map((item) => element("listItem", [paragraphNode(item)])),
        { start: 1 },
      );
    case "tasks":
      return element(
        "taskList",
        block.items.map((item) => element("taskItem", [paragraphNode(item.content)], { checked: item.checked })),
      );
  }
}

export function createSection(meta: SectionMeta, blocks: NoteBlock[]): Y.XmlElement {
  const body = blocks.length > 0 ? blocks : [paragraph(SECTION_PLACEHOLDER, true)];
  return element(SECTION_NODE, body.map(blockNode), { ...meta });
}

// --- finding and filling sections --------------------------------------------------

export function findSection(fragment: Y.XmlFragment, mediaItemId: string): Y.XmlElement | null {
  for (const child of fragment.toArray()) {
    if (child instanceof Y.XmlElement && child.nodeName === SECTION_NODE && child.getAttribute("mediaItemId") === mediaItemId) {
      return child;
    }
  }
  return null;
}

/** True while a section holds only what the gateway put there to wait. */
export function isPlaceholder(section: Y.XmlElement): boolean {
  const children = section.toArray();
  if (children.length !== 1) return false;
  const only = children[0];
  if (!(only instanceof Y.XmlElement) || only.nodeName !== "paragraph") return false;
  return only.toArray().map((part) => (part instanceof Y.XmlText ? part.toString() : "")).join("")
    .replace(/<[^>]+>/g, "") === SECTION_PLACEHOLDER;
}

/**
 * Lands an upload's results in its section. The gateway only ever adds: if
 * nobody has touched the placeholder it is replaced, but once a person has
 * typed in the section their words stay exactly as they are and the results go
 * after them. Returns what it did, for the caller's logs and tests.
 */
export function fillSection(section: Y.XmlElement, blocks: NoteBlock[], status: SectionStatus): "replaced" | "appended" {
  section.setAttribute("status", status);
  if (blocks.length === 0) return isPlaceholder(section) ? "replaced" : "appended";
  const nodes = blocks.map(blockNode);
  if (isPlaceholder(section)) {
    section.delete(0, section.length);
    section.insert(0, nodes);
    return "replaced";
  }
  section.insert(section.length, nodes);
  return "appended";
}
