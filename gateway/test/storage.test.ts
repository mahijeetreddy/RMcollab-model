import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storage, verifyFileSignature } from "../src/storage/local.js";

const root = path.resolve(os.tmpdir(), "rmcollab-gateway-test-storage");

const signedParams = (relPath: string) => {
  const url = new URL(storage.publicUrl(relPath));
  return {
    exp: url.searchParams.get("exp") ?? undefined,
    sig: url.searchParams.get("sig") ?? undefined,
  };
};

describe("storage.resolve path traversal guard", () => {
  it.each(["../etc/passwd", "rooms/../../x", "..\\..\\x", "rooms\\..\\..\\x", ".."])(
    "rejects %s",
    (input) => {
      expect(() => storage.resolve(input)).toThrow(/escapes storage root/);
    },
  );

  it("accepts a normal media path inside the root", () => {
    expect(storage.resolve("rooms/r1/m1/original.png")).toBe(
      path.join(root, "rooms", "r1", "m1", "original.png"),
    );
  });

  it("treats a leading slash as root-relative rather than absolute", () => {
    expect(storage.resolve("/rooms/r1/a.png")).toBe(path.join(root, "rooms", "r1", "a.png"));
  });
});

describe("presigned file URLs", () => {
  const filePath = "rooms/r1/m1/original.png";

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips publicUrl through verifyFileSignature", () => {
    expect(storage.publicUrl(filePath).startsWith("http://gateway.test/files/rooms/r1/m1/")).toBe(
      true,
    );
    const { exp, sig } = signedParams(filePath);
    expect(verifyFileSignature(filePath, exp, sig)).toEqual({ ok: true });
  });

  it("rejects a tampered signature", () => {
    const { exp, sig } = signedParams(filePath);
    const flipped = (sig![0] === "a" ? "b" : "a") + sig!.slice(1);
    expect(verifyFileSignature(filePath, exp, flipped)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a signature minted for a different path", () => {
    const { exp, sig } = signedParams("rooms/r2/m9/original.png");
    expect(verifyFileSignature(filePath, exp, sig)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a signature of the wrong length without throwing", () => {
    const { exp } = signedParams(filePath);
    expect(verifyFileSignature(filePath, exp, "abc")).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a missing sig", () => {
    const { exp } = signedParams(filePath);
    expect(verifyFileSignature(filePath, exp, undefined)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a non-numeric or missing exp", () => {
    const { sig } = signedParams(filePath);
    expect(verifyFileSignature(filePath, "soon", sig)).toEqual({ ok: false, reason: "invalid" });
    expect(verifyFileSignature(filePath, undefined, sig)).toEqual({ ok: false, reason: "invalid" });
  });

  it("rejects a genuinely signed link once it has expired", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const { exp, sig } = signedParams(filePath);
    expect(verifyFileSignature(filePath, exp, sig)).toEqual({ ok: true });

    vi.setSystemTime(new Date("2026-01-01T01:00:01Z")); // TTL is 3600s in test/setup.ts
    expect(verifyFileSignature(filePath, exp, sig)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an exp in the past even with an arbitrary sig", () => {
    const past = String(Math.floor(Date.now() / 1000) - 10);
    expect(verifyFileSignature(filePath, past, "deadbeef")).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});
