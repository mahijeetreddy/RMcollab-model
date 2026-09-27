import { LIBRARY_MATCH_END as E, LIBRARY_MATCH_START as S } from "@rmcollab/shared";
import { describe, expect, it } from "vitest";
import { parseSnippet } from "../src/lib/snippet";

describe("parseSnippet", () => {
  it("splits marked matches from the text around them", () => {
    expect(parseSnippet(`how to ${S}scale${E} a ${S}gateway${E} out`, false)).toEqual([
      { text: "how to ", match: false },
      { text: "scale", match: true },
      { text: " a ", match: false },
      { text: "gateway", match: true },
      { text: " out", match: false },
    ]);
  });

  it("drops transcript stamps, including one cut off by the fragment", () => {
    const parts = parseSnippet(`05] first line\n[00:00:09] the ${S}queue${E} next`, true);
    expect(parts.map((p) => p.text).join("")).toBe("first line the queue next");
    expect(parts.find((p) => p.match)?.text).toBe("queue");
  });

  it("keeps stamps in documents that are not transcripts", () => {
    expect(parseSnippet("meet at [10:30:00] sharp", false)[0]!.text).toBe("meet at [10:30:00] sharp");
  });

  it("treats markup as text", () => {
    const hostile = `<img src=x onerror=alert(1)> ${S}<b>${E}`;
    expect(parseSnippet(hostile, false)).toEqual([
      { text: "<img src=x onerror=alert(1)> ", match: false },
      { text: "<b>", match: true },
    ]);
  });

  it("handles an unterminated match and empty input", () => {
    expect(parseSnippet(`a ${S}b`, false)).toEqual([
      { text: "a ", match: false },
      { text: "b", match: true },
    ]);
    expect(parseSnippet("", false)).toEqual([]);
  });
});
