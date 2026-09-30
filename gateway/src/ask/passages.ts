/**
 * Splits a document into passages for Ask the room: small enough that several
 * fit in one prompt, specific enough to be worth citing, and carrying what a
 * citation needs to point back - the time a transcript passage is spoken.
 */

export interface Passage {
  body: string;
  /** Seconds into the recording where the passage starts; transcripts only. */
  startS: number | null;
}

/** Aim for about this many characters a passage; a paragraph or a spoken line is never cut to fit. */
export const TARGET_CHARS = 700;
/** A single paragraph longer than this is split at sentence ends. */
export const MAX_CHARS = 1000;

const STAMPED = /^\[(\d+):(\d{2}):(\d{2})\]\s*(.*)$/;
const HEADING = /^(?:#{1,6}\s+(.+?)\s*#*|(?:\*\*|__)([^*_]+?):?(?:\*\*|__):?)\s*$/;

export function splitPassages(kind: string, body: string): Passage[] {
  const text = body.replace(/\r\n?/g, "\n").trim();
  if (!text) return [];
  return kind === "transcript" && STAMPED.test(text.split("\n", 1)[0]!) ? splitTranscript(text) : splitDocument(text);
}

/**
 * Consecutive spoken lines, packed to the target. Each passage repeats the
 * previous one's last line, so an answer that straddles a boundary is whole in
 * at least one of them. Timestamps are dropped from the text - they carry no
 * meaning for the search or the model - and kept as the start time.
 */
function splitTranscript(text: string): Passage[] {
  const lines = text
    .split("\n")
    .map((line) => STAMPED.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match && match[4]!.trim()))
    .map((match) => ({ at: Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]), text: match[4]!.trim() }));

  const passages: Passage[] = [];
  let current: typeof lines = [];
  const length = (group: typeof lines) => group.reduce((sum, line) => sum + line.text.length + 1, 0);
  for (const line of lines) {
    if (current.length > 0 && length(current) + line.text.length > TARGET_CHARS) {
      passages.push({ body: current.map((l) => l.text).join(" "), startS: current[0]!.at });
      // Carry the last line over, unless it alone already fills a passage.
      const last = current[current.length - 1]!;
      current = current.length > 1 && last.text.length < TARGET_CHARS / 2 ? [last] : [];
    }
    current.push(line);
  }
  if (current.length > 0) passages.push({ body: current.map((l) => l.text).join(" "), startS: current[0]!.at });
  return passages;
}

/** Splits a paragraph that is too long on its own at sentence ends, then hard. */
function pieces(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];
  const sentences = paragraph.match(/[^.!?]+(?:[.!?]+["')\]]*\s*|$)/g) ?? [paragraph];
  const out: string[] = [];
  let buffer = "";
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length > TARGET_CHARS) {
      out.push(buffer.trim());
      buffer = "";
    }
    buffer += sentence;
    while (buffer.length > MAX_CHARS) {
      out.push(buffer.slice(0, MAX_CHARS).trim());
      buffer = buffer.slice(MAX_CHARS);
    }
  }
  if (buffer.trim()) out.push(buffer.trim());
  return out;
}

/**
 * Paragraphs packed to the target. A heading never ends a passage - it belongs
 * with what follows - and a passage that starts partway through a section is
 * prefixed with that section's heading, so "Priya drafts it" still reads as an
 * action item to the search and to the model.
 */
function splitDocument(text: string): Passage[] {
  const passages: Passage[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];
  let bufferHasContent = false;
  const size = () => buffer.reduce((sum, part) => sum + part.length + 2, 0);
  const flush = () => {
    if (bufferHasContent) passages.push({ body: buffer.join("\n\n"), startS: null });
    buffer = [];
    bufferHasContent = false;
  };

  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split("\n", 1)[0]!;
    const match = HEADING.exec(firstLine);
    if (match) {
      heading = (match[1] ?? match[2] ?? "").trim();
      // A new section starts a new passage once the current one has substance.
      if (bufferHasContent && size() > TARGET_CHARS / 2) flush();
    }
    const rest = match ? trimmed.slice(firstLine.length).trim() : trimmed;
    if (match) buffer.push(firstLine.trim());
    if (!rest) continue;
    for (const piece of pieces(rest)) {
      if (bufferHasContent && size() + piece.length > TARGET_CHARS) {
        flush();
        if (heading) buffer.push(heading);
      }
      buffer.push(piece);
      bufferHasContent = true;
    }
  }
  flush();
  return passages;
}
