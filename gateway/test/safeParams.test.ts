import { describe, expect, it } from "vitest";
import { safeParams } from "../src/http/routes/media.js";

describe("safeParams", () => {
  it("keeps the harmless options an upload may set", () => {
    expect(safeParams({ denoise: false, language: "de" })).toEqual({ denoise: false, language: "de" });
  });

  it("drops what decides a job's cost or what a worker downloads", () => {
    expect(
      safeParams({ model: "large-v3", device: "cuda:7", beam_size: 10_000, tile: 1, grid: 1e6, language: "../../x", denoise: "yes" }),
    ).toEqual({});
  });
});
