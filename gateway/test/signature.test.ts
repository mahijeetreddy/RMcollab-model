import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSecret, signPayload, verifySignature } from "../src/webhooks/signature.js";

const secret = "whsec_test";
const body = JSON.stringify({ event: "room.created", id: "r1" });
const now = () => Math.floor(Date.now() / 1000);

describe("webhook signatures", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips signPayload -> verifySignature", () => {
    const header = signPayload(body, secret, now());
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifySignature(body, secret, header)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const header = signPayload(body, secret, now());
    expect(verifySignature(body.replace("r1", "r2"), secret, header)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signPayload(body, secret, now());
    expect(verifySignature(body, "whsec_other", header)).toBe(false);
  });

  it("rejects a timestamp outside the tolerance window", () => {
    expect(verifySignature(body, secret, signPayload(body, secret, now() - 301))).toBe(false);
    expect(verifySignature(body, secret, signPayload(body, secret, now() + 301))).toBe(false);
    expect(verifySignature(body, secret, signPayload(body, secret, now() - 30), 10)).toBe(false);
  });

  it("rejects a replay once the original header ages out", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const header = signPayload(body, secret, now());
    expect(verifySignature(body, secret, header)).toBe(true);
    vi.setSystemTime(new Date("2026-01-01T00:05:01Z"));
    expect(verifySignature(body, secret, header)).toBe(false);
  });

  it("returns false rather than throwing for a v1 of a different length", () => {
    // timingSafeEqual throws on unequal lengths; the length guard must short-circuit first.
    const header = `t=${now()},v1=abcd`;
    expect(() => verifySignature(body, secret, header)).not.toThrow();
    expect(verifySignature(body, secret, header)).toBe(false);
  });

  it.each(["", "garbage", "t=abc,v1=00", "v1=00", `t=${Math.floor(Date.now() / 1000)}`])(
    "rejects malformed header %j",
    (header) => {
      expect(verifySignature(body, secret, header)).toBe(false);
    },
  );

  it("generates distinct prefixed secrets", () => {
    const a = generateSecret();
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(generateSecret()).not.toBe(a);
  });
});
