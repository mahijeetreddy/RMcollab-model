/**
 * Word-level diff between an original text and its rewrite, for showing what a
 * rewrite changed. A light edit - tightened wording, citation markers dropped -
 * is invisible side by side; marked up inline it is obvious.
 *
 * Two levels, because texts can run to 200k characters and word-level LCS is
 * quadratic: paragraphs are matched first (cheap - there are few of them), and
 * only the stretches between unchanged paragraphs are diffed word by word. A
 * rewrite that merges or splits paragraphs still diffs sensibly, because each
 * changed stretch is compared as a whole. Past a size cap a stretch is shown as
 * replaced outright rather than freezing the tab.
 */

export type DiffOp = "equal" | "insert" | "delete";

export interface DiffPart {
  op: DiffOp;
  text: string;
}

export interface DiffStats {
  wordsAdded: number;
  wordsRemoved: number;
  /** Separate changed regions, which is what a reader counts as "edits". */
  changes: number;
}

/** Above this many LCS cells a stretch is marked replaced instead of diffed. */
export const MAX_CELLS = 2_500_000;

// Words (letters, digits, apostrophes and in-word hyphens), runs of whitespace,
// or single punctuation marks - so "archeology[a]" diffs as word + brackets.
const TOKEN = /[\p{L}\p{N}_]+(?:['’‐‑-][\p{L}\p{N}_]+)*|\s+|[^\p{L}\p{N}_\s]/gu;

export function tokenize(text: string): string[] {
  return text.match(TOKEN) ?? [];
}

const isSpace = (token: string) => /^\s+$/.test(token);
// Any whitespace equals any other: a rewrite that reflows lines has not changed
// the words, and marking every newline as an edit buries the real ones. The same
// goes for look-alike characters - seen in practice, a model rewrote every
// "cross-disciplinary" with a non-breaking hyphen (U+2011), which showed as a
// deletion and an insertion of what reads as the same word.
const key = (token: string) =>
  isSpace(token)
    ? " "
    : token
        .replace(/[‐‑‒]/g, "-")
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"');

function push(parts: DiffPart[], op: DiffOp, text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.op === op) last.text += text;
  else parts.push({ op, text });
}

/** LCS over tokens, after trimming the common prefix and suffix. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const parts: DiffPart[] = [];

  let start = 0;
  while (start < a.length && start < b.length && key(a[start]!) === key(b[start]!)) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && key(a[endA - 1]!) === key(b[endB - 1]!)) {
    endA -= 1;
    endB -= 1;
  }

  // Equal runs take the rewrite's whitespace: it is the text being displayed.
  push(parts, "equal", b.slice(0, start).join(""));

  const n = endA - start;
  const m = endB - start;
  if (n * m > MAX_CELLS) {
    push(parts, "delete", a.slice(start, endA).join(""));
    push(parts, "insert", b.slice(start, endB).join(""));
  } else if (n > 0 || m > 0) {
    // lengths[i][j] = LCS of a[start+i..endA) and b[start+j..endB), flattened.
    const width = m + 1;
    const lengths = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lengths[i * width + j] =
          key(a[start + i]!) === key(b[start + j]!)
            ? lengths[(i + 1) * width + j + 1]! + 1
            : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && key(a[start + i]!) === key(b[start + j]!)) {
        push(parts, "equal", b[start + j]!);
        i += 1;
        j += 1;
      } else if (j < m && (i >= n || lengths[i * width + j + 1]! >= lengths[(i + 1) * width + j]!)) {
        push(parts, "insert", b[start + j]!);
        j += 1;
      } else {
        push(parts, "delete", a[start + i]!);
        i += 1;
      }
    }
  }

  push(parts, "equal", b.slice(endB).join(""));
  return tidy(parts);
}

/**
 * Readability pass. A lone space between two edits splits one change into
 * three fragments ("~~the~~ ~~old~~" + "++a++ ++new++"); folding that space into
 * the edit on both sides reads as one replacement. Deletions then go before
 * insertions within each changed region.
 */
function tidy(parts: DiffPart[]): DiffPart[] {
  const folded: DiffPart[] = [];
  parts.forEach((part, index) => {
    const between =
      part.op === "equal" &&
      isSpace(part.text) &&
      index > 0 &&
      index < parts.length - 1 &&
      parts[index - 1]!.op !== "equal" &&
      parts[index + 1]!.op !== "equal";
    if (between) {
      folded.push({ op: "delete", text: part.text }, { op: "insert", text: part.text });
    } else {
      folded.push({ ...part });
    }
  });

  const out: DiffPart[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    push(out, "delete", removed);
    push(out, "insert", added);
    removed = "";
    added = "";
  };
  for (const part of folded) {
    if (part.op === "delete") removed += part.text;
    else if (part.op === "insert") added += part.text;
    else {
      flush();
      push(out, "equal", part.text);
    }
  }
  flush();
  return out;
}

const PARAGRAPH = /(?<=\n)/;
const normalise = (paragraph: string) => paragraph.trim().replace(/\s+/g, " ");

/** Paragraph alignment first, then word diffs inside each changed stretch. */
export function diffText(before: string, after: string): DiffPart[] {
  const a = before.split(PARAGRAPH);
  const b = after.split(PARAGRAPH);
  if (a.length === 1 || b.length === 1) return diffWords(before, after);

  const n = a.length;
  const m = b.length;
  // Each distinct paragraph becomes an integer once, so the table compares
  // numbers. Normalising inside the loop meant two regex passes per cell -
  // 320,000 for a 400-paragraph document - which is what made it slow.
  const ids = new Map<string, number>();
  const idOf = (paragraph: string) => {
    const key = normalise(paragraph);
    if (key === "") return -1; // blank lines never anchor an alignment
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const idsA = Int32Array.from(a, idOf);
  const idsB = Int32Array.from(b, (p) => (normalise(p) === "" ? -2 : idOf(p)));
  const same = (i: number, j: number) => idsA[i]! >= 0 && idsA[i] === idsB[j];

  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lengths[i * width + j] = same(i, j)
        ? lengths[(i + 1) * width + j + 1]! + 1
        : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }

  const parts: DiffPart[] = [];
  let gapA = "";
  let gapB = "";
  const flushGap = () => {
    if (gapA || gapB) for (const part of diffWords(gapA, gapB)) push(parts, part.op, part.text);
    gapA = "";
    gapB = "";
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && same(i, j)) {
      flushGap();
      push(parts, "equal", b[j]!);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lengths[i * width + j + 1]! >= lengths[(i + 1) * width + j]!)) {
      gapB += b[j]!;
      j += 1;
    } else {
      gapA += a[i]!;
      i += 1;
    }
  }
  flushGap();
  return parts;
}

const countWords = (text: string) => tokenize(text).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;

export function diffStats(parts: DiffPart[]): DiffStats {
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let changes = 0;
  let inChange = false;
  for (const part of parts) {
    if (part.op === "equal") {
      inChange = false;
      continue;
    }
    if (!inChange) changes += 1;
    inChange = true;
    if (part.op === "insert") wordsAdded += countWords(part.text);
    else wordsRemoved += countWords(part.text);
  }
  return { wordsAdded, wordsRemoved, changes };
}

/** The rewrite reassembled from a diff; the tests use it to prove nothing is lost. */
export function applied(parts: DiffPart[]): string {
  return parts.filter((p) => p.op !== "delete").map((p) => p.text).join("");
}

export function reverted(parts: DiffPart[]): string {
  return parts.filter((p) => p.op !== "insert").map((p) => p.text).join("");
}
