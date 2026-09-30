import type { Node as PMNode } from "@tiptap/pm/model";
import { defaultMarkdownSerializer, MarkdownSerializer } from "prosemirror-markdown";
import { SECTION_NODE, SECTION_PLACEHOLDER } from "@rmcollab/shared/notes";
import { isSourceHref } from "../ask/sourceLinks";

/**
 * The room's notes as a Markdown file. Serialised from the editor's own
 * document, so it is exactly what everyone sees - including upload sections,
 * checklists and highlights, which have no place in the default serialiser.
 */

const KIND_LABEL: Record<string, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };
const STATUS_NOTE: Record<string, string> = { processing: "still being processed", failed: "could not be processed" };

export interface Appendix {
  title: string;
  text: string;
}

export interface ExportOptions {
  roomName: string;
  /** When the file was made; also stamps the file name. */
  at?: Date;
  /** Full texts to add at the end, such as transcripts. */
  appendix?: Appendix[];
}

const d = defaultMarkdownSerializer.nodes;
const m = defaultMarkdownSerializer.marks;

function formatDate(value: Date | number): string {
  return new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function shallowest(section: PMNode): number {
  let level = 6;
  section.forEach((child) => {
    if (child.type.name === "heading") level = Math.min(level, child.attrs.level as number);
  });
  return level;
}

function sectionMeta(node: PMNode): string {
  const { mediaType, author, createdAt, status } = node.attrs as Record<string, string | number | null>;
  return [
    KIND_LABEL[String(mediaType)] ?? "Upload",
    author,
    typeof createdAt === "number" ? formatDate(createdAt) : null,
    status && STATUS_NOTE[String(status)],
  ]
    .filter(Boolean)
    .join(" · ");
}

const serializer = new MarkdownSerializer(
  {
    doc: (state, node) => state.renderContent(node),
    paragraph: d.paragraph!,
    text: d.text!,
    hardBreak: d.hard_break!,
    blockquote: d.blockquote!,
    horizontalRule: d.horizontal_rule!,
    codeBlock: (state, node) => {
      // The default reads `params`; this schema calls it `language`.
      const fence = node.textContent.includes("```") ? "~~~~" : "```";
      state.write(fence + (node.attrs.language ?? "") + "\n");
      state.text(node.textContent, false);
      state.ensureNewLine();
      state.write(fence);
      state.closeBlock(node);
    },
    heading: (state, node, parent) => {
      // A section's title is "##", so its shallowest heading becomes "###" and
      // the rest keep their depth relative to it.
      const level = parent.type.name === SECTION_NODE ? Math.min(6, node.attrs.level - shallowest(parent) + 3) : node.attrs.level;
      state.write(`${"#".repeat(level)} `);
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    bulletList: (state, node) => state.renderList(node, "  ", () => "- "),
    orderedList: (state, node) => {
      const start = (node.attrs.start as number | null) ?? 1;
      const width = String(start + node.childCount - 1).length;
      state.renderList(node, " ".repeat(width + 2), (i) => {
        const n = String(start + i);
        return `${" ".repeat(width - n.length)}${n}. `;
      });
    },
    listItem: (state, node) => state.renderContent(node),
    taskList: (state, node) =>
      state.renderList(node, "  ", (i) => `- [${node.child(i).attrs.checked ? "x" : " "}] `),
    taskItem: (state, node) => state.renderContent(node),
    [SECTION_NODE]: (state, node) => {
      state.write(`## ${state.esc(String(node.attrs.title ?? "Upload"), true)}`);
      state.closeBlock(node);
      state.write(`_${state.esc(sectionMeta(node))}_`);
      state.closeBlock(node);
      // A section still waiting on its job holds only the placeholder line.
      if (node.textContent.trim() !== SECTION_PLACEHOLDER) state.renderContent(node);
      state.closeBlock(node);
    },
  },
  {
    bold: m.strong!,
    italic: m.em!,
    code: m.code!,
    link: {
      open: (state, mark, parent, index) =>
        isSourceHref(mark.attrs.href as string) ? "" : (m.link!.open as (...args: unknown[]) => string)(state, mark, parent, index),
      close: (state, mark, parent, index) =>
        isSourceHref(mark.attrs.href as string) ? "" : (m.link!.close as (...args: unknown[]) => string)(state, mark, parent, index),
      mixable: m.link!.mixable,
    },
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    highlight: { open: "==", close: "==", mixable: true, expelEnclosingWhitespace: true },
    // Markdown has no underline; the words are kept, the styling is not.
    underline: { open: "", close: "", mixable: true },
  },
  { hardBreakNodeName: "hardBreak" },
);

/** Escapes a line of plain text so no Markdown reader takes it as syntax. */
function plainLine(line: string): string {
  return line.replace(/([\\`*_[\]<>~=|])/g, "\\$1").replace(/^(\s*)([#>+-]|\d+[.)])(\s)/, "$1\\$2$3");
}

export function notesToMarkdown(doc: PMNode, { roomName, at = new Date(), appendix = [] }: ExportOptions): string {
  const parts = [`# ${plainLine(roomName)} notes`, `_Exported from RMcollab on ${formatDate(at)}_`];
  const body = serializer.serialize(doc, { tightLists: true }).trim();
  if (body) parts.push(body);
  const texts = appendix.filter((entry) => entry.text.trim());
  if (texts.length > 0) {
    parts.push("---", "## Appendix: full transcripts");
    for (const entry of texts) {
      const lines = entry.text.trim().split(/\r?\n/).filter((line) => line.trim());
      // Hard breaks keep one spoken line per line without a paragraph each.
      parts.push(`### ${plainLine(entry.title)}`, lines.map(plainLine).join("  \n"));
    }
  }
  return `${parts.join("\n\n")}\n`;
}

export function exportFileName(roomName: string, at = new Date()): string {
  const slug =
    roomName
      .toLowerCase()
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "room";
  const day = [at.getFullYear(), at.getMonth() + 1, at.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
  return `${slug}-notes-${day}.md`;
}
