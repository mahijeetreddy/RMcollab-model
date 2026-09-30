import type { JSONContent } from "@tiptap/core";
import type { AskSource } from "@rmcollab/shared";
import { parseMarkdown, type Inline } from "../../lib/markdown";
import { formatDuration } from "../../lib/transcript";
import { sourceHref } from "./sourceLinks";
import type { AskTurn } from "./useAsk";

/**
 * A finished answer as notes content: the question as a heading, the answer,
 * and a line naming each cited source. Every citation - the [n] in the text
 * and each entry in the sources line - is a link to its source, so anyone in
 * the room can follow it from the notes. Built as editor JSON, never HTML: the
 * answer is model-written.
 */

type Mark = NonNullable<JSONContent["marks"]>[number];

const linkTo = (source: AskSource): Mark => ({
  type: "link",
  // No target: a citation opens inside the app, not in a new tab.
  attrs: { href: sourceHref(source), target: null, rel: null },
});

const node = (value: string, marks: Mark[]): JSONContent | null =>
  value ? { type: "text", text: value, ...(marks.length ? { marks } : {}) } : null;

/** A run of text with each [n] that names a source turned into a link; one that names none is dropped. */
function cited(value: string, marks: Mark[], sources: AskSource[]): JSONContent[] {
  const known = (n: string) => sources.some((s) => s.n === Number(n));
  return value
    // A citation that names no source goes, with the space before it.
    .replace(/\s*\[(\d{1,2})\]/g, (whole, n: string) => (known(n) ? whole : ""))
    .split(/(\[\d{1,2}\])/g)
    .map((part) => {
      const match = /^\[(\d{1,2})\]$/.exec(part);
      if (!match) return node(part, marks);
      const source = sources.find((s) => s.n === Number(match[1]));
      return source ? node(part, [...marks, linkTo(source)]) : null;
    })
    .filter((n): n is JSONContent => n !== null);
}

function inline(content: Inline[], sources: AskSource[]): JSONContent[] {
  return content.flatMap((part) => {
    if (part.kind === "code") return node(part.text, [{ type: "code" }]) ?? [];
    const marks: Mark[] = part.kind === "strong" ? [{ type: "bold" }] : part.kind === "em" ? [{ type: "italic" }] : [];
    return cited(part.text, marks, sources);
  });
}

const paragraph = (content: JSONContent[]): JSONContent => ({ type: "paragraph", ...(content.length ? { content } : {}) });

export function sourceLabel(source: AskSource): string {
  if (source.kind === "transcript" && source.atSeconds !== null) return `${source.title}, at ${formatDuration(source.atSeconds)}`;
  if (source.kind === "summary") return `summary of ${source.title}`;
  if (source.kind === "notes") return `notes: ${source.title}`;
  return source.title;
}

export function answerToNotes(turn: AskTurn): JSONContent[] {
  const body: JSONContent[] = [];
  for (const block of parseMarkdown(turn.text)) {
    if (block.kind === "list") {
      body.push({
        type: block.ordered ? "orderedList" : "bulletList",
        content: block.items.map((item) => ({ type: "listItem", content: [paragraph(inline(item, turn.sources))] })),
      });
    } else {
      body.push(paragraph(inline(block.content, turn.sources)));
    }
  }

  const sources = turn.cited
    .map((n) => turn.sources.find((s) => s.n === n))
    .filter((s): s is AskSource => Boolean(s));
  const italic: Mark = { type: "italic" };
  const line: JSONContent[] = [node("Sources: ", [italic])!];
  sources.forEach((source, i) => {
    if (i > 0) line.push(node(" · ", [italic])!);
    line.push(node(`[${source.n}] ${sourceLabel(source)}`, [italic, linkTo(source)])!);
  });

  return [
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: turn.question }] },
    ...body,
    ...(sources.length ? [paragraph(line)] : []),
  ];
}
