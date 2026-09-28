import type { StrategyDescriptor } from "@rmcollab/shared";
import { describe, expect, it } from "vitest";
import { classify, countWords, detectText, formatDuration, formatSize } from "../src/lib/detect";
import { allOptions, recommend, SUMMARY_WORDS } from "../src/lib/recommend";

const s = (mediaType: string, name: string, o: Partial<StrategyDescriptor> = {}): StrategyDescriptor => ({
  mediaType: mediaType as StrategyDescriptor["mediaType"],
  name,
  label: name,
  description: "",
  isDefault: false,
  available: true,
  ...o,
});

// What the workers advertise on the running stack.
const LIVE: StrategyDescriptor[] = [
  s("text", "rulebased", { isDefault: true }),
  s("text", "rewrite"),
  s("text", "summarise"),
  s("image", "notes", { isDefault: true }),
  s("image", "realesrgan"),
  s("image", "classical"),
  s("audio", "comprehend", { isDefault: true }),
  s("audio", "transcribe"),
  s("audio", "spectral"),
  s("audio", "deepfilternet"),
  s("video", "comprehend", { isDefault: true }),
  s("video", "classical"),
  s("video", "realesrgan"),
];

const titles = (proposals: ReturnType<typeof recommend>) => proposals.map((p) => p.title);

describe("classify", () => {
  it.each([
    ["lecture.mp3", "audio/mpeg", "audio"],
    ["board.JPG", "", "image"],
    ["clip.mov", "video/quicktime", "video"],
    ["notes.md", "", "text"],
    ["recording.m4a", "", "audio"],
    ["mystery.bin", "application/octet-stream", null],
  ])("%s (%s) is %s", (name, mime, expected) => {
    expect(classify(name, mime)).toBe(expected);
  });

  it("trusts a MIME type over a misleading extension", () => {
    expect(classify("photo.txt", "image/png")).toBe("image");
  });
});

describe("measuring", () => {
  it("counts words, including contractions and hyphenated words", () => {
    expect(countWords("We'll re-read chapter 4, then meet.")).toBe(6);
    expect(detectText("one two three").summary).toBe("3 words");
  });

  it.each([
    [45, "45 s"],
    [150, "3 min"],
    [3600, "1 h"],
    [4500, "1 h 15 min"],
  ])("%ss reads as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });

  it("sizes files readably", () => {
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(formatSize(80 * 1024 * 1024)).toBe("80 MB");
  });
});

describe("recommend", () => {
  it("offers a short text polishing, and a long one a summary", () => {
    const short = recommend(detectText("teh group met on thursday"), LIVE);
    expect(short[0]).toMatchObject({ title: "Polish the writing", recommended: true });

    const long = recommend(detectText("word ".repeat(SUMMARY_WORDS + 10)), LIVE);
    expect(long[0]).toMatchObject({ title: "Summarise", recommended: true });
    expect(long[0]!.detail).toContain("words is a lot to polish");
  });

  it("recommends exactly one action, and puts it first", () => {
    for (const kind of ["image", "audio", "video"] as const) {
      const proposals = recommend({ kind, summary: "" }, LIVE);
      expect(proposals.filter((p) => p.recommended)).toHaveLength(1);
      expect(proposals[0]!.recommended).toBe(true);
    }
  });

  it("reads an image into notes, and falls back to upscaling without a vision model", () => {
    expect(titles(recommend({ kind: "image", summary: "" }, LIVE))).toEqual([
      "Read into notes",
      "Sharpen & upscale",
      "Quick brightness fix",
    ]);
    const noVision = LIVE.map((x) => (x.name === "notes" ? { ...x, available: false } : x));
    const proposals = recommend({ kind: "image", summary: "" }, noVision);
    // Nothing disappears: the unavailable option is last, with why.
    expect(proposals.map((p) => [p.title, p.recommended, p.available])).toEqual([
      ["Sharpen & upscale", true, true],
      ["Quick brightness fix", false, true],
      ["Read into notes", false, false],
    ]);
    expect(proposals[2]!.detail).toContain("no image-reading model");
  });

  it("says why upscaling suits a small image", () => {
    const proposals = recommend({ kind: "image", summary: "", width: 640, height: 480 }, LIVE);
    expect(proposals.find((p) => p.strategy === "realesrgan")!.detail).toContain("640×480");
  });

  it("estimates how long a recording takes", () => {
    const [first] = recommend({ kind: "audio", summary: "", durationS: 42 * 60 }, LIVE);
    expect(first).toMatchObject({ title: "Transcribe & summarise" });
    expect(first!.detail).toBe("About 5 min for 42 min");
  });

  it("without a language model, a short text falls back to the offline fix", () => {
    const noLlm = LIVE.map((x) => (x.name === "rewrite" || x.name === "summarise" ? { ...x, available: false } : x));
    expect(recommend(detectText("a short note"), noLlm)[0]).toMatchObject({ title: "Fix typos only", recommended: true });
  });

  it("leaves strategies without a plain-language intent to More options", () => {
    const withExtra = [...LIVE, s("image", "experimental-gan")];
    expect(titles(recommend({ kind: "image", summary: "" }, withExtra))).not.toContain("experimental-gan");
    expect(allOptions("image", withExtra).map((x) => x.name)).toContain("experimental-gan");
  });

  it("returns nothing to propose when no worker serves the kind", () => {
    expect(recommend({ kind: "video", summary: "" }, LIVE.filter((x) => x.mediaType !== "video"))).toEqual([]);
  });

  it("only argues for an option when the argument holds", () => {
    // Regression: Summarise said "11 words is a lot to polish" on a short note.
    const short = recommend(detectText("teh group met on thursday"), LIVE);
    expect(short.find((p) => p.strategy === "summarise")!.detail).toBe("Key points, decisions and action items");
    const long = recommend(detectText("word ".repeat(SUMMARY_WORDS + 10)), LIVE);
    expect(long.find((p) => p.strategy === "rewrite")!.detail).toBe("Clearer and more readable, same meaning");
  });
});
