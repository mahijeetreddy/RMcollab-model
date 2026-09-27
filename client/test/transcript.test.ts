import { describe, expect, it } from "vitest";
import { findMatches, formatDuration, parseTranscript } from "../src/lib/transcript";

describe("parseTranscript", () => {
  it("reads the worker's [HH:MM:SS] format into seconds", () => {
    const segments = parseTranscript("[00:00:00] Hello.\n[00:01:05] Queues next.\n[01:00:02] Done.\n");
    expect(segments).toEqual([
      { start: 0, stamp: "00:00:00", text: "Hello." },
      { start: 65, stamp: "00:01:05", text: "Queues next." },
      { start: 3602, stamp: "01:00:02", text: "Done." },
    ]);
  });

  it("joins an unstamped line onto the segment before it", () => {
    const segments = parseTranscript("[00:00:03] First half\nsecond half\n");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe("First half second half");
  });

  it("keeps text that precedes any stamp instead of dropping it", () => {
    const segments = parseTranscript("preamble\n[00:00:04] body");
    expect(segments.map((s) => [s.start, s.text])).toEqual([
      [0, "preamble"],
      [4, "body"],
    ]);
  });

  it("tolerates CRLF, blank lines and stamps over 99 hours", () => {
    const segments = parseTranscript("\r\n[00:00:01] a\r\n\r\n[100:00:00] b\r\n");
    expect(segments.map((s) => s.start)).toEqual([1, 360000]);
  });

  it("returns nothing for empty input", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("\n\n  \n")).toEqual([]);
  });
});

describe("findMatches", () => {
  it("finds every case-insensitive occurrence", () => {
    expect(findMatches("Queue the queue, QUEUE!", "queue")).toEqual([
      [0, 5],
      [10, 15],
      [17, 22],
    ]);
  });

  it("matches nothing for a blank query rather than everything", () => {
    expect(findMatches("anything", "")).toEqual([]);
    expect(findMatches("anything", "   ")).toEqual([]);
  });

  it("does not overlap matches", () => {
    expect(findMatches("aaaa", "aa")).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [5, "0:05"],
    [65, "1:05"],
    [3599.6, "1:00:00"],
    [3725, "1:02:05"],
    [-3, "0:00"],
  ])("%s seconds is %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});
