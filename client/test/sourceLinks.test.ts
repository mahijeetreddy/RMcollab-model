import type { AskSource } from "@rmcollab/shared";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { parseSourceHref, sourceHref } from "../src/features/ask/sourceLinks";
import { answerToNotes } from "../src/features/ask/toNotes";
import type { AskTurn } from "../src/features/ask/useAsk";
import { notesToMarkdown } from "../src/features/notes/exportMarkdown";
import { schemaExtensions } from "../src/features/notes/schema";

const source = (o: Partial<AskSource>): AskSource => ({
  n: 1,
  kind: "transcript",
  title: "lecture.mp3",
  excerpt: "",
  mediaItemId: "m1_abc",
  artifactId: "a1-xyz",
  atSeconds: 372,
  notesKey: null,
  docId: null,
  ...o,
});

const turn = (text: string, sources: AskSource[], cited: number[]): AskTurn => ({
  requestId: "r",
  question: "Which broker?",
  status: "done",
  sources,
  text,
  cited,
  fallback: null,
  noEvidence: false,
  model: null,
  standalone: null,
  startedAt: 0,
  finishedAt: 1,
});

describe("citation links", () => {
  it("round-trip everything needed to open a source", () => {
    expect(parseSourceHref(sourceHref(source({})))).toEqual({
      kind: "transcript",
      mediaItemId: "m1_abc",
      artifactId: "a1-xyz",
      atSeconds: 372,
      notesKey: null,
    });
    const notes = source({ kind: "notes", mediaItemId: null, artifactId: null, atSeconds: null, notesKey: "h:3" });
    expect(parseSourceHref(sourceHref(notes))).toMatchObject({ kind: "notes", notesKey: "h:3" });
  });

  it("ignore links that are not citations, or were tampered with", () => {
    expect(parseSourceHref("https://example.com")).toBeNull();
    expect(parseSourceHref("#rmc-source?k=transcript&m=bad id")).toBeNull();
    expect(parseSourceHref("#rmc-source?k=script&m=m1")).toBeNull();
    expect(parseSourceHref("#rmc-source?k=notes&n=javascript:alert(1)")).toBeNull();
    expect(parseSourceHref("#rmc-source?k=document")).toBeNull();
  });
});

describe("an answer added to the notes", () => {
  const schema = getSchema(schemaExtensions());
  const sources = [source({ n: 1 }), source({ n: 2, kind: "summary", title: "test.jpg", mediaItemId: "m2", atSeconds: null })];
  const content = answerToNotes(turn("Redis Streams [1], as the summary says [2]. Not [7].", sources, [1, 2]));
  // Loaded into the real schema, as the editor would, so links survive it.
  const doc = schema.nodeFromJSON({ type: "doc", content });
  const links: { text: string; href: string }[] = [];
  doc.descendants((node) => {
    const link = node.marks.find((m) => m.type.name === "link");
    if (node.isText && link) links.push({ text: node.text!, href: link.attrs.href as string });
  });

  it("links every citation in the text and every entry in the sources line", () => {
    expect(links.map((l) => l.text)).toEqual(["[1]", "[2]", "[1] lecture.mp3, at 6:12", "[2] summary of test.jpg"]);
    expect(parseSourceHref(links[0]!.href)).toMatchObject({ kind: "transcript", mediaItemId: "m1_abc", atSeconds: 372 });
    expect(parseSourceHref(links[3]!.href)).toMatchObject({ kind: "summary", mediaItemId: "m2" });
  });

  it("drops a citation with no source rather than linking it nowhere", () => {
    expect(doc.textContent).not.toContain("[7]");
    expect(doc.textContent).toContain("says [2]. Not.");
  });

  it("opens in the app, never a new tab", () => {
    doc.descendants((node) => {
      const link = node.marks.find((m) => m.type.name === "link");
      if (link) expect(link.attrs.target).toBeNull();
    });
  });

  it("exports to Markdown as plain citations: an in-app link means nothing outside it", () => {
    const md = notesToMarkdown(doc, { roomName: "R" });
    // Escaped brackets: Markdown for a literal [1], not a link reference.
    expect(md).toContain("Redis Streams \\[1\\], as the summary says \\[2\\].");
    expect(md).not.toContain("rmc-source");
  });
});
