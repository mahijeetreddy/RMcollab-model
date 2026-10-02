import { describe, expect, it } from "vitest";
import { TokenBucket } from "../src/ws/rateLimit.js";

describe("TokenBucket", () => {
  it("allows a burst, then only the sustained rate", () => {
    const bucket = new TokenBucket(3, 1, 0);
    expect([bucket.take(1, 0), bucket.take(1, 0), bucket.take(1, 0), bucket.take(1, 0)]).toEqual([true, true, true, false]);
    // One second later, one more.
    expect(bucket.take(1, 1000)).toBe(true);
    expect(bucket.take(1, 1000)).toBe(false);
  });

  it("never refills past its capacity", () => {
    const bucket = new TokenBucket(2, 10, 0);
    expect(bucket.take(2, 60_000)).toBe(true);
    expect(bucket.take(1, 60_000)).toBe(false);
  });

  it("takes nothing when a large cost does not fit", () => {
    const bucket = new TokenBucket(100, 1, 0);
    expect(bucket.take(150, 0)).toBe(false);
    expect(bucket.take(100, 0)).toBe(true);
  });
});
