import { describe, expect, it } from "vitest";
import { buildCatalogue, queueFor, type StrategyAdvert } from "../src/queue/routing.js";

const AUTO = "auto";

const advert = (
  o: Partial<StrategyAdvert> & Pick<StrategyAdvert, "name" | "media_type">,
): StrategyAdvert => ({
  label: o.name,
  description: "",
  is_default: false,
  available: true,
  explicit_default: false,
  ...o,
});

// What the pools actually advertise after video comprehension moved to audio.
const AUDIO_POOL: StrategyAdvert[] = [
  advert({ media_type: "audio", name: "comprehend", is_default: true, explicit_default: true, queue: "enhance.audio" }),
  advert({ media_type: "audio", name: "spectral", queue: "enhance.audio" }),
  advert({ media_type: "video", name: "comprehend", is_default: true, explicit_default: true, queue: "enhance.audio" }),
];
const VIDEO_POOL: StrategyAdvert[] = [
  // Alone, the video pool falls back to classical and reports it as its default.
  advert({ media_type: "video", name: "classical", is_default: true, queue: "enhance.video" }),
  advert({ media_type: "video", name: "realesrgan", queue: "enhance.video" }),
];

const defaultFor = (adverts: StrategyAdvert[], mediaType: string) =>
  buildCatalogue(adverts).strategies.filter((s) => s.mediaType === mediaType && s.isDefault).map((s) => s.name);

describe("buildCatalogue: one default per media type across pools", () => {
  it("prefers a declared default over a pool's fallback", () => {
    expect(defaultFor([...VIDEO_POOL, ...AUDIO_POOL], "video")).toEqual(["comprehend"]);
    // Order of arrival must not matter.
    expect(defaultFor([...AUDIO_POOL, ...VIDEO_POOL], "video")).toEqual(["comprehend"]);
  });

  it("falls back to what can run when the declared default is unavailable", () => {
    const whisperMissing = AUDIO_POOL.map((a) => (a.media_type === "video" ? { ...a, available: false } : a));
    expect(defaultFor([...VIDEO_POOL, ...whisperMissing], "video")).toEqual(["classical"]);
  });

  it("degrades to the video pool's own default when the audio pool is down", () => {
    expect(defaultFor(VIDEO_POOL, "video")).toEqual(["classical"]);
  });

  it("still names a default when nothing is available, so the picker is never blank", () => {
    const down = VIDEO_POOL.map((a) => ({ ...a, available: false }));
    expect(defaultFor(down, "video")).toHaveLength(1);
  });

  it("lists defaults first within each media type", () => {
    const names = buildCatalogue([...VIDEO_POOL, ...AUDIO_POOL]).strategies.map((s) => `${s.mediaType}:${s.name}`);
    expect(names).toEqual([
      "audio:comprehend",
      "audio:spectral",
      "video:comprehend",
      "video:classical",
      "video:realesrgan",
    ]);
  });
});

describe("queueFor", () => {
  const catalogue = buildCatalogue([...VIDEO_POOL, ...AUDIO_POOL]);

  it("sends video comprehension to the audio pool that advertised it", () => {
    expect(queueFor(catalogue, "video", "comprehend", AUTO)).toBe("enhance.audio");
  });

  it("sends 'auto' wherever the merged default runs", () => {
    expect(queueFor(catalogue, "video", AUTO, AUTO)).toBe("enhance.audio");
  });

  it("keeps upscaling in the video pool", () => {
    expect(queueFor(catalogue, "video", "realesrgan", AUTO)).toBe("enhance.video");
    expect(queueFor(catalogue, "video", "classical", AUTO)).toBe("enhance.video");
  });

  it("falls back to the media type's queue for anything it has not seen", () => {
    // Before the first advert lands, or after a pool's adverts expire, a job
    // still goes somewhere a worker can resolve a fallback and explain it.
    expect(queueFor(buildCatalogue([]), "video", "comprehend", AUTO)).toBe("enhance.video");
    expect(queueFor(catalogue, "video", "not-a-strategy", AUTO)).toBe("enhance.video");
  });

  it("treats an advert from an older worker, without a queue, as its media type's", () => {
    const { queue: _dropped, ...withoutQueue } = advert({ media_type: "image", name: "classical", is_default: true, queue: "x" });
    const legacy = buildCatalogue([withoutQueue as StrategyAdvert]);
    expect(queueFor(legacy, "image", "classical", AUTO)).toBe("enhance.image");
  });
});
