import { describe, expect, it } from "vitest";
import { waitingWords } from "../src/features/jobs/MediaJobCard";

describe("waitingWords", () => {
  it("says where a waiting job stands", () => {
    expect(waitingWords(undefined)).toBe("Waiting for a worker");
    expect(waitingWords(0)).toBe("Next in line");
    expect(waitingWords(3)).toBe("3 ahead in the queue");
  });
});
