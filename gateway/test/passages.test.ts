import { describe, expect, it } from "vitest";
import { MAX_CHARS, splitPassages, TARGET_CHARS } from "../src/ask/passages.js";

const stamp = (s: number) =>
  `[${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
const line = (s: number, words: number) => `${stamp(s)} ${Array.from({ length: words }, (_, i) => `w${s}x${i}`).join(" ")}.`;

describe("transcripts", () => {
  it("packs spoken lines to the target, each passage starting at its first line's time", () => {
    const text = Array.from({ length: 60 }, (_, i) => line(i * 5, 12)).join("\n");
    const passages = splitPassages("transcript", text);
    expect(passages.length).toBeGreaterThan(3);
    for (const p of passages) {
      expect(p.body.length).toBeLessThanOrEqual(TARGET_CHARS + 120);
      expect(p.body).not.toMatch(/\[\d\d:/); // stamps are dropped from the text
      expect(p.startS).not.toBeNull();
    }
    expect(passages[0]!.startS).toBe(0);
    // Times only move forward.
    const starts = passages.map((p) => p.startS!);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("overlaps neighbours by one line, so nothing said at a boundary is lost", () => {
    const text = Array.from({ length: 40 }, (_, i) => line(i, 12)).join("\n");
    const [first, second] = splitPassages("transcript", text);
    const lastOfFirst = first!.body.split(". ").at(-1)!.replace(/\.$/, "");
    expect(second!.body.startsWith(lastOfFirst)).toBe(true);
  });

  it("covers every line", () => {
    const lines = Array.from({ length: 50 }, (_, i) => line(i * 3, 9));
    const joined = splitPassages("transcript", lines.join("\n"))
      .map((p) => p.body)
      .join(" ");
    for (const l of lines) expect(joined).toContain(l.replace(/^\[[^\]]+\]\s*/, ""));
  });

  it("reads hours, not just minutes", () => {
    const [p] = splitPassages("transcript", "[01:02:03] late in the lecture.");
    expect(p).toEqual({ body: "late in the lecture.", startS: 3723 });
  });
});

describe("documents", () => {
  const SUMMARY = [
    "**Summary**",
    "The seminar covered message queues, worker pools and scaling a gateway.",
    "",
    "**Key points**",
    "- Streams over Kafka",
    "- Consumer groups",
    "",
    "**Action items**",
    "- Priya drafts the consumer groups section",
  ].join("\n");

  it("keeps a short summary as one passage, headings and all", () => {
    const passages = splitPassages("summary", SUMMARY);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.body).toContain("**Action items**");
    expect(passages[0]!.startS).toBeNull();
  });

  it("prefixes a passage that starts mid-section with that section's heading", () => {
    const long = (n: number) => `Paragraph ${n}: ${"words about the action item ".repeat(12).trim()}.`;
    const text = ["## Action items", long(1), long(2), long(3), long(4)].join("\n\n");
    const passages = splitPassages("enhanced", text);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages.slice(1)) expect(p.body.startsWith("Action items\n\n")).toBe(true);
  });

  it("never ends a passage on a bare heading", () => {
    const para = "x ".repeat(300).trim();
    const passages = splitPassages("summary", ["## One", para, "## Two", para, "## Three", para].join("\n\n"));
    for (const p of passages) expect(p.body.trim()).not.toMatch(/(^|\n)##? ?\w+$/);
  });

  it("splits a paragraph that is too long on its own at sentence ends", () => {
    const sentence = "This sentence is here to make one very long paragraph. ";
    const passages = splitPassages("enhanced", sentence.repeat(60));
    expect(passages.length).toBeGreaterThan(2);
    for (const p of passages) {
      expect(p.body.length).toBeLessThanOrEqual(MAX_CHARS);
      expect(p.body.endsWith(".")).toBe(true);
    }
  });

  it("returns nothing for an empty document, and a transcript without stamps is treated as prose", () => {
    expect(splitPassages("summary", "  \n ")).toEqual([]);
    expect(splitPassages("transcript", "just words")).toEqual([{ body: "just words", startS: null }]);
  });
});
