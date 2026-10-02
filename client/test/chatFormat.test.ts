import { describe, expect, it } from "vitest";
import { formatTime, linkParts } from "../src/lib/format";

describe("formatTime", () => {
  const now = new Date(2026, 8, 30, 15, 0).getTime(); // Wed 30 Sep 2026, 15:00
  const at = (day: number, hour = 10) => new Date(2026, 8, day, hour, 30).getTime();

  it("is just the time today", () => {
    expect(formatTime(at(30), now)).not.toMatch(/Yesterday|,/);
  });

  it("says yesterday, then the weekday within a week, then the date", () => {
    expect(formatTime(at(29), now)).toMatch(/^Yesterday /);
    expect(formatTime(at(27), now)).toMatch(/^\S+ \d/); // e.g. "Sun 10:30"
    expect(formatTime(at(10), now)).toMatch(/,/); // e.g. "10 Sep, 10:30"
  });
});

describe("linkParts", () => {
  it("finds http and https links, leaving the sentence's punctuation out", () => {
    expect(linkParts("see https://example.com/a?b=1. thanks")).toEqual([
      { text: "see " },
      { text: "https://example.com/a?b=1", href: "https://example.com/a?b=1" },
      { text: ". thanks" },
    ]);
  });

  it("links nothing else - no javascript:, no bare words", () => {
    expect(linkParts("javascript:alert(1) and example.com")).toEqual([{ text: "javascript:alert(1) and example.com" }]);
  });
});
