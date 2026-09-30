import { EMBEDDING_DIMENSIONS } from "@rmcollab/shared";
import { describe, expect, it } from "vitest";
import { citations, clock, describeSource, plainBrackets, plainExcerpt, toSource, withoutDuplicates } from "../src/ask/service.js";
import { decodeVector, keywordQuery, toVectorLiteral, type Retrieved } from "../src/ask/store.js";

const hit = (overrides: Partial<Retrieved>): Retrieved => ({
  id: "p:1",
  score: 0.03,
  body: "the decision is Redis Streams",
  kind: "transcript",
  title: "lecture.mp3",
  mediaItemId: "m1",
  mediaType: "audio",
  artifactId: "a1",
  startS: 372,
  notesKey: null,
  ...overrides,
});

describe("citations", () => {
  it("keeps real sources in order of first use, once each", () => {
    expect(citations("Redis Streams [2], not Kafka [1][2]. See [3].", 3)).toEqual([2, 1, 3]);
  });

  it("drops a number the model was never given", () => {
    expect(citations("As shown [9] and [0] and [2].", 3)).toEqual([2]);
  });

  it("reads the full-width brackets some models cite with, even split across pieces", () => {
    // Seen from gpt-oss: "...for a class project【1】".
    const streamed = ["Redis Streams【", "1】 and ［2］."].map(plainBrackets).join("");
    expect(streamed).toBe("Redis Streams[1] and [2].");
    expect(citations(streamed, 2)).toEqual([1, 2]);
  });

  it("finds nothing in an answer without citations", () => {
    expect(citations("The room's material doesn't cover this.", 4)).toEqual([]);
  });
});

describe("what the model is told about each passage", () => {
  it("names the recording and when it is said", () => {
    expect(describeSource(hit({}))).toBe("Recording lecture.mp3, at 6:12");
    expect(describeSource(hit({ mediaType: "video", startS: 3725 }))).toBe("Video lecture.mp3, at 1:02:05");
  });

  it("names summaries, documents, image notes and notes sections", () => {
    expect(describeSource(hit({ kind: "summary" }))).toBe("Summary of lecture.mp3");
    expect(describeSource(hit({ kind: "document", mediaType: "text", title: "Text from Alice" }))).toBe("Document: Text from Alice");
    expect(describeSource(hit({ kind: "document", mediaType: "image", title: "board.jpg" }))).toBe("Notes from the image board.jpg");
    expect(describeSource(hit({ kind: "notes", title: "Decisions", mediaItemId: null }))).toBe("Room notes: Decisions");
  });

  it("formats times like a player does", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(65.9)).toBe("1:05");
    expect(clock(3600)).toBe("1:00:00");
  });
});

describe("choosing passages", () => {
  it("skips an upload's notes section when a passage from that upload is already in", () => {
    const ranked = [
      hit({ id: "p:1", mediaItemId: "m1" }),
      hit({ id: "n:main|u:m1#0", kind: "notes", notesKey: "main|u:m1#0", mediaItemId: null, artifactId: null }),
      hit({ id: "n:main|h:0#0", kind: "notes", notesKey: "main|h:0#0", mediaItemId: null, artifactId: null }),
    ];
    expect(withoutDuplicates(ranked, 8).map((r) => r.id)).toEqual(["p:1", "n:main|h:0#0"]);
  });

  it("drops the section even when it outranks the upload, and links a kept one to its upload", () => {
    const section = hit({ id: "n:main|u:m1#0", kind: "notes", notesKey: "main|u:m1#0", mediaItemId: null, artifactId: null });
    expect(withoutDuplicates([section, hit({ id: "p:1", mediaItemId: "m1" })], 8).map((r) => r.id)).toEqual(["p:1"]);
    // Alone - its upload's documents did not rank - it stays, pointing at the upload.
    expect(withoutDuplicates([section], 8)).toEqual([{ ...section, mediaItemId: "m1" }]);
  });

  it("stops at the limit", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => hit({ id: `p:${i}`, mediaItemId: `m${i}` }));
    expect(withoutDuplicates(ranked, 8)).toHaveLength(8);
  });

  it("gives the client a short excerpt and the section to scroll to, not the retrieval piece", () => {
    const source = toSource(hit({ kind: "notes", notesKey: "d0cument1|h:2#1", body: "word ".repeat(200) }), 4);
    expect(source).toMatchObject({ n: 4, kind: "notes", notesKey: "h:2", docId: "d0cument1" });
    expect(source.excerpt.length).toBeLessThanOrEqual(281);
    expect(source.excerpt.endsWith("…")).toBe(true);
  });
});

describe("keyword query", () => {
  it("joins a question's words with or, so any of them can match", () => {
    expect(keywordQuery("Why didn't we go with Kafka?")).toBe("Why or didn't or we or go or with or Kafka");
  });

  it("leaves nothing for search syntax to act on", () => {
    expect(keywordQuery('"quoted" -minus OR (paren) <> !')).toBe("quoted or minus or OR or paren");
    expect(keywordQuery("???")).toBe("");
  });
});

describe("vectors on the wire", () => {
  it("decodes the worker's base64 float32s, whatever the buffer's alignment", () => {
    const values = Float32Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => i / 10);
    const encoded = Buffer.from(values.buffer).toString("base64");
    const decoded = decodeVector(encoded);
    expect(decoded[0]).toBe(0);
    expect(decoded[5]).toBeCloseTo(0.5);
    expect(toVectorLiteral([0.5, -1])).toBe("[0.5,-1]");
  });

  it("refuses a vector of the wrong size", () => {
    expect(() => decodeVector(Buffer.from(new Float32Array(3).buffer).toString("base64"))).toThrow(/768/);
  });
});

describe("source excerpts", () => {
  it("read as text, not Markdown", () => {
    expect(plainExcerpt("## Message queues\n- decouple producers\n- **Redis Streams** > Kafka\n\n- [ ] Priya drafts it")).toBe(
      "Message queues decouple producers Redis Streams > Kafka Priya drafts it",
    );
  });
});
