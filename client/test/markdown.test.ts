import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown, type Block } from "../src/lib/markdown";

const kinds = (blocks: Block[]) => blocks.map((b) => b.kind);

describe("parseMarkdown", () => {
  it("reads the shape the summarise prompt asks for", () => {
    const blocks = parseMarkdown(
      [
        "## Summary",
        "The lecture covered **queues** and fan-out.",
        "",
        "## Key points",
        "- Workers pull from Redis",
        "- Gateways are stateless",
        "",
        "## Action items",
        "1. Read chapter 3",
        "2. Try `npm run scale`",
      ].join("\n"),
    );
    expect(kinds(blocks)).toEqual(["heading", "paragraph", "heading", "list", "heading", "list"]);
    const actions = blocks[5] as Extract<Block, { kind: "list" }>;
    expect(actions.ordered).toBe(true);
    expect(actions.items[1]).toEqual([
      { kind: "text", text: "Try " },
      { kind: "code", text: "npm run scale" },
    ]);
  });

  it("treats a bold line as a section heading, as models often write them", () => {
    for (const line of ["**Key points**", "**Key points:**", "**Key points**:", "__Key points__"]) {
      const [block] = parseMarkdown(line);
      expect(block).toEqual({ kind: "heading", level: 1, content: [{ kind: "text", text: "Key points" }] });
    }
  });

  it("does not mistake a bold phrase inside a sentence for a heading", () => {
    expect(kinds(parseMarkdown("**Note** this is a sentence."))).toEqual(["paragraph"]);
  });

  it("maps # and ## to the top level, and deeper headings below it", () => {
    const levels = parseMarkdown("# A\n## B\n### C\n#### D\n###### E").map((b) =>
      b.kind === "heading" ? b.level : null,
    );
    expect(levels).toEqual([1, 1, 2, 3, 3]);
  });

  it("splits a list when it switches between bullets and numbers", () => {
    expect(kinds(parseMarkdown("- a\n- b\n1. c"))).toEqual(["list", "list"]);
  });

  it("joins wrapped paragraph lines and indented bullet continuations", () => {
    const [para, list] = parseMarkdown("one\ntwo\n\n- item\n  continued");
    expect(para).toEqual({ kind: "paragraph", content: [{ kind: "text", text: "one two" }] });
    expect((list as Extract<Block, { kind: "list" }>).items[0]).toEqual([
      { kind: "text", text: "item continued" },
    ]);
  });

  it("keeps markup-looking text as inert text", () => {
    // Summaries are model output: nothing in them may become an element.
    const hostile = '<img src=x onerror="alert(1)"> <script>alert(2)</script>';
    const [block] = parseMarkdown(hostile);
    expect(block).toEqual({ kind: "paragraph", content: [{ kind: "text", text: hostile }] });
  });

  it("drops rules and fences rather than rendering them as text", () => {
    expect(kinds(parseMarkdown("before\n---\n```\nafter"))).toEqual(["paragraph", "paragraph"]);
  });

  it("returns nothing for empty input", () => {
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseInline", () => {
  it("separates bold, emphasis and code from plain text", () => {
    expect(parseInline("a **b** *c* `d` e")).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " " },
      { kind: "em", text: "c" },
      { kind: "text", text: " " },
      { kind: "code", text: "d" },
      { kind: "text", text: " e" },
    ]);
  });

  it("leaves a lone asterisk or arithmetic alone", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ kind: "text", text: "2 * 3 = 6" }]);
  });

  it("does not treat snake_case identifiers as emphasis", () => {
    expect(parseInline("set job_artifacts and room_members")).toEqual([
      { kind: "text", text: "set job_artifacts and room_members" },
    ]);
  });
});
