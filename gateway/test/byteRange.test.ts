import { describe, expect, it } from "vitest";
import { byteRange } from "../src/http/routes/media.js";

describe("byteRange", () => {
  it("reads the forms a media player sends", () => {
    expect(byteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
    expect(byteRange("bytes=500-599", 1000)).toEqual({ start: 500, end: 599 });
    expect(byteRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    // An end past the file is clamped, not refused.
    expect(byteRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
  });

  it("serves the whole file for anything it does not handle", () => {
    expect(byteRange(undefined, 1000)).toBeNull();
    expect(byteRange("bytes=0-1,5-9", 1000)).toBeNull();
    expect(byteRange("items=0-1", 1000)).toBeNull();
    expect(byteRange("bytes=-", 1000)).toBeNull();
  });

  it("refuses a range that starts past the end", () => {
    expect(byteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=5-2", 1000)).toBe("unsatisfiable");
    expect(byteRange("bytes=-0", 1000)).toBe("unsatisfiable");
  });
});
