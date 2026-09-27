/**
 * A deliberately small Markdown subset for model-written summaries.
 *
 * Summaries come from an LLM, so they are untrusted input. Rather than pull in a
 * renderer and sanitise its HTML, this parses into a tree that React renders as
 * elements: there is no path from summary text to markup at all. It covers what
 * the summarise prompt asks for - headings, bullets, paragraphs, bold and code -
 * and degrades anything else to plain text.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "code"; text: string };

export type Block =
  /** Relative depth: 1 is a top-level section. The view maps it to a real h-level. */
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "paragraph"; content: Inline[] };

// Underscore emphasis only opens and closes at a word boundary, as in CommonMark,
// so identifiers like job_artifacts in a technical summary stay intact.
const INLINE =
  /(\*\*[^*]+\*\*|(?<![\p{L}\p{N}])__[^_]+__(?![\p{L}\p{N}])|`[^`]+`|\*[^*\s][^*]*\*|(?<![\p{L}\p{N}])_[^_\s][^_]*_(?![\p{L}\p{N}]))/u;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  for (const part of text.split(INLINE)) {
    if (!part) continue;
    if (/^(\*\*|__).+\1$/.test(part)) out.push({ kind: "strong", text: part.slice(2, -2) });
    else if (/^`.+`$/.test(part)) out.push({ kind: "code", text: part.slice(1, -1) });
    else if (/^([*_]).+\1$/.test(part) && part.length > 2)
      out.push({ kind: "em", text: part.slice(1, -1) });
    else out.push({ kind: "text", text: part });
  }
  return out;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*$/;
// Models often write a section title as a bold line ("**Key points**" or
// "**Key points:**") instead of a heading; treat it as one.
const BOLD_HEADING = /^(?:\*\*|__)([^*_]+?):?(?:\*\*|__):?$/;
const BULLET = /^[-*+•]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", content: parseInline(paragraph.join(" ")) });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items.map(parseInline) });
    list = null;
  };

  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^([-*_])\1{2,}$/.test(line) || line.startsWith("```")) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line) ?? null;
    const boldHeading = heading ? null : BOLD_HEADING.exec(line);
    if (heading || boldHeading) {
      flushParagraph();
      flushList();
      // "#" and "##" are both treated as top-level: models use them interchangeably.
      const depth = heading ? heading[1]!.length : 1;
      const level = Math.min(3, Math.max(1, depth - 1)) as 1 | 2 | 3;
      const title = heading ? heading[2]! : boldHeading![1]!;
      blocks.push({ kind: "heading", level, content: parseInline(title) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      if (list && list.ordered !== ordered) flushList();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }

    // An indented continuation of a bullet belongs to it, not a new paragraph.
    if (list && /^\s{2,}/.test(raw)) {
      const items = list.items;
      items[items.length - 1] = `${items[items.length - 1] ?? ""} ${line}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}
