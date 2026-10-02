import { describe, expect, it } from "vitest";
import { retryAfter } from "../src/limits.js";

describe("retryAfter", () => {
  it("is when the given event leaves the window", () => {
    const now = 1_000_000;
    // The event that must expire was 20 s ago, in a 60 s window: 40 s from now.
    expect(retryAfter(["id", String(now - 20_000)], 60, now)).toBe(40);
  });

  it("is never less than a second", () => {
    expect(retryAfter(["id", "0"], 60, 1_000_000)).toBe(1);
  });
});
