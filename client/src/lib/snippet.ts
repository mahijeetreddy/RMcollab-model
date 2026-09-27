import { LIBRARY_MATCH_END, LIBRARY_MATCH_START } from "@rmcollab/shared";

export interface SnippetPart {
  text: string;
  match: boolean;
}

// A full stamp anywhere, or the tail of one cut off at the start of a fragment.
const STAMP = /\[?\d+:\d{2}:\d{2}\]\s*|^\d{2}\]\s*/g;

/**
 * Splits a library snippet into plain and matched runs. The server marks
 * matches with control characters, not tags, so this is the only place a
 * highlight comes from and nothing in a snippet is ever treated as markup.
 * Transcript stamps are dropped: the entry already says where the hit is.
 */
export function parseSnippet(snippet: string, stripStamps: boolean): SnippetPart[] {
  const parts: SnippetPart[] = [];
  let match = false;
  let buffer = "";
  const flush = () => {
    const text = stripStamps ? buffer.replace(STAMP, "") : buffer;
    if (text) {
      const last = parts[parts.length - 1];
      if (last && last.match === match) last.text += text;
      else parts.push({ text, match });
    }
    buffer = "";
  };
  for (const char of snippet) {
    if (char === LIBRARY_MATCH_START || char === LIBRARY_MATCH_END) {
      flush();
      match = char === LIBRARY_MATCH_START;
    } else {
      buffer += char;
    }
  }
  flush();

  // Collapse the whitespace left behind by removed stamps and line breaks.
  for (const part of parts) part.text = part.text.replace(/\s+/g, " ");
  const first = parts[0];
  if (first) first.text = first.text.trimStart();
  const last = parts[parts.length - 1];
  if (last) last.text = last.text.trimEnd();
  return parts.filter((part) => part.text.length > 0);
}
