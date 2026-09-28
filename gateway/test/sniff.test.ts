import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveMediaType, sniffMedia } from "../src/http/sniff.js";

const fixture = (name: string) => readFileSync(new URL(`../../e2e/fixtures/${name}`, import.meta.url));
const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));

describe("sniffMedia on real files", () => {
  it.each([
    ["lecture.mp3", ["audio"], "mp3"],
    ["lecture.mp4", ["video", "audio"], "mp4"],
    ["whiteboard.jpg", ["image"], "jpg"],
    ["small.png", ["image"], "png"],
  ])("%s is %j", (name, kinds, ext) => {
    expect(sniffMedia(fixture(name))).toMatchObject({ kinds, ext });
  });
});

describe("sniffMedia signatures", () => {
  it.each([
    ["WAV", bytes("RIFF", [0, 0, 0, 0], "WAVE"), "audio"],
    ["WebP", bytes("RIFF", [0, 0, 0, 0], "WEBP"), "image"],
    ["AVI", bytes("RIFF", [0, 0, 0, 0], "AVI "), "video"],
    ["M4A", bytes([0, 0, 0, 0x20], "ftypM4A "), "audio"],
    ["MOV", bytes([0, 0, 0, 0x14], "ftypqt  "), "video"],
    ["FLAC", bytes("fLaC", [0, 0, 0, 0]), "audio"],
    ["GIF", bytes("GIF89a", [1, 0]), "image"],
    ["MPEG frame", bytes([0xff, 0xfb, 0x90, 0x44]), "audio"],
    ["WebM", bytes([0x1a, 0x45, 0xdf, 0xa3, 0, 0]), "video"],
  ])("%s", (_name, buf, first) => {
    expect(sniffMedia(buf)?.kinds[0]).toBe(first);
  });

  it("reads UTF-8 prose as text, accents and all", () => {
    expect(sniffMedia(Buffer.from("Café notes - naïve résumé, 42 %", "utf8"))?.kinds).toEqual(["text"]);
  });

  it("keeps text whose 8KB sample cuts a multi-byte character in half", () => {
    // "€" is three bytes and 8192 is not a multiple of three, so the sample
    // ends mid-character - which must not make the text look binary.
    const text = Buffer.from("€".repeat(3000), "utf8");
    expect(8192 % 3).not.toBe(0);
    expect(sniffMedia(text)?.kinds).toEqual(["text"]);
  });

  it("refuses binary that is none of the supported kinds", () => {
    expect(sniffMedia(bytes([0x7f], "ELF", [2, 1, 1, 0, 0, 0]))).toBeNull();
    // A ZIP - which is also what a .docx is - carries NUL bytes: refused, not
    // mistaken for text.
    expect(sniffMedia(bytes("PK", [3, 4, 20, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffMedia(Buffer.from([0x00, 0x01, 0x02, 0xfe, 0x00]))).toBeNull();
  });
});

describe("resolveMediaType", () => {
  it("accepts the declared kind when the container allows it", () => {
    const mp4 = sniffMedia(fixture("lecture.mp4"))!;
    expect(resolveMediaType(mp4, "audio")).toEqual({ mediaType: "audio", overridden: false });
    expect(resolveMediaType(mp4, "video")).toEqual({ mediaType: "video", overridden: false });
  });

  it("lets the bytes win over a wrong label", () => {
    // A PNG renamed photo.txt used to be routed to the text workers.
    const png = sniffMedia(fixture("small.png"))!;
    expect(resolveMediaType(png, "text")).toEqual({ mediaType: "image", overridden: true });
  });

  it("uses the content when nothing was declared", () => {
    expect(resolveMediaType(sniffMedia(fixture("lecture.mp3"))!, null)).toEqual({ mediaType: "audio", overridden: false });
  });
});
