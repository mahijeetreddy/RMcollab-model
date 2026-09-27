import { describe, expect, it } from "vitest";
import {
  applied,
  diffStats,
  diffText,
  diffWords,
  MAX_CELLS,
  reverted,
  tokenize,
  type DiffPart,
} from "../src/lib/diff";

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

/** The two properties every diff must have, whatever it looks like. */
function expectFaithful(parts: DiffPart[], before: string, after: string) {
  expect(applied(parts)).toBe(after);
  expect(squash(reverted(parts))).toBe(squash(before));
}

// From the rewrite that prompted this view: "both look the same to me".
const ORIGINAL =
  "Archaeology or archeology[a] is the study of human activity through the recovery and analysis " +
  "of material culture. The archaeological record consists of artifacts, architecture, biofacts or " +
  "ecofacts, sites, and cultural landscapes. Archaeology can be considered both a social science and " +
  "a branch of the humanities.[1][2][3]";
const REWRITE =
  "Archaeology, also spelled archeology, is the study of human activity through the recovery and " +
  "analysis of material culture. The archaeological record includes artifacts, architecture, biofacts " +
  "or ecofacts, sites, and cultural landscapes. Archaeology can be regarded both as a social science " +
  "and as a branch of the humanities.";

describe("tokenize", () => {
  it("splits words, whitespace and punctuation, keeping contractions whole", () => {
    expect(tokenize("don't stop, re-read [a]")).toEqual(["don't", " ", "stop", ",", " ", "re-read", " ", "[", "a", "]"]);
  });

  it("loses nothing: tokens join back to the input", () => {
    const text = "Tabs\tand  spaces,\nnewlines — em dashes… and ünïcode 42%";
    expect(tokenize(text).join("")).toBe(text);
  });
});

describe("diffWords", () => {
  it("returns a single equal part for identical text", () => {
    expect(diffWords("same text", "same text")).toEqual([{ op: "equal", text: "same text" }]);
  });

  it("marks a replaced word as one deletion followed by one insertion", () => {
    expect(diffWords("the record consists of sites", "the record includes sites")).toEqual([
      { op: "equal", text: "the record " },
      { op: "delete", text: "consists of" },
      { op: "insert", text: "includes" },
      { op: "equal", text: " sites" },
    ]);
  });

  it("finds the edits in the real rewrite that looked unchanged", () => {
    const parts = diffWords(ORIGINAL, REWRITE);
    expectFaithful(parts, ORIGINAL, REWRITE);
    const removed = parts.filter((p) => p.op === "delete").map((p) => p.text).join("|");
    const added = parts.filter((p) => p.op === "insert").map((p) => p.text).join("|");
    expect(removed).toContain("consists of");
    expect(added).toContain("includes");
    expect(removed).toContain("[1][2][3]");
    expect(added).toContain("regarded");
    // Most of the text is untouched, which is exactly why it looked the same.
    const kept = parts.filter((p) => p.op === "equal").map((p) => p.text).join("");
    expect(kept.length).toBeGreaterThan(REWRITE.length * 0.7);
  });

  it("does not report reflowed whitespace as an edit", () => {
    expect(diffWords("one two\nthree", "one  two three")).toEqual([{ op: "equal", text: "one  two three" }]);
  });

  it("does not report look-alike characters as edits", () => {
    // Groq rewrote "cross-disciplinary" with a non-breaking hyphen (U+2011) and
    // the first diff marked it as a change that no reader could see.
    const parts = diffWords("cross-disciplinary, four-field, it's \"quoted\"", "cross‑disciplinary, four‐field, it’s “quoted”");
    expect(parts).toHaveLength(1);
    expect(parts[0]!.op).toBe("equal");
  });

  it("handles empty inputs on either side", () => {
    expect(diffWords("", "added")).toEqual([{ op: "insert", text: "added" }]);
    expect(diffWords("removed", "")).toEqual([{ op: "delete", text: "removed" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("falls back to a whole replacement past the size cap instead of hanging", () => {
    const side = Math.ceil(Math.sqrt(MAX_CELLS)) + 50;
    const before = Array.from({ length: side }, (_, i) => `a${i}`).join(" ");
    const after = Array.from({ length: side }, (_, i) => `b${i}`).join(" ");
    const started = performance.now();
    const parts = diffWords(before, after);
    expect(performance.now() - started).toBeLessThan(1000);
    expectFaithful(parts, before, after);
    expect(parts.map((p) => p.op)).toEqual(["delete", "insert"]);
  });
});

describe("diffText", () => {
  it("keeps unchanged paragraphs whole and diffs only the edited one", () => {
    const before = "Intro stays.\nThe midterm is on oct 14.\nOutro stays.\n";
    const after = "Intro stays.\nThe midterm is on October 14.\nOutro stays.\n";
    const parts = diffText(before, after);
    expectFaithful(parts, before, after);
    expect(parts.filter((p) => p.op !== "equal")).toEqual([
      { op: "delete", text: "oct" },
      { op: "insert", text: "October" },
    ]);
  });

  it("copes with a rewrite that merges two paragraphs", () => {
    const before = "First point.\nSecond point.\nUnchanged end.\n";
    const after = "First point, and second point.\nUnchanged end.\n";
    expectFaithful(diffText(before, after), before, after);
  });

  it("stays fast on a long, lightly edited document", () => {
    const paragraphs = Array.from({ length: 400 }, (_, i) => `Paragraph ${i} says something about queues and workers.`);
    const before = paragraphs.join("\n");
    const after = paragraphs.map((p, i) => (i % 50 === 0 ? p.replace("queues", "streams") : p)).join("\n");
    const started = performance.now();
    const parts = diffText(before, after);
    expect(performance.now() - started).toBeLessThan(500);
    expectFaithful(parts, before, after);
    expect(diffStats(parts).changes).toBe(8);
  });
});

describe("diffStats", () => {
  it("counts words, not characters or whitespace, and separate regions as separate edits", () => {
    const stats = diffStats(diffWords("the old red car was here", "the new red car is here"));
    expect(stats).toEqual({ wordsAdded: 2, wordsRemoved: 2, changes: 2 });
  });

  it("reports no changes for identical text", () => {
    expect(diffStats(diffWords("same", "same"))).toEqual({ wordsAdded: 0, wordsRemoved: 0, changes: 0 });
  });
});
