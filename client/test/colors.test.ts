import { describe, expect, it } from "vitest";
import { collaboratorColor, safeColor } from "../src/lib/colors";

describe("collaboratorColor", () => {
  it("is a hex colour, which is all the cursor extension accepts", () => {
    for (const id of ["a", "participant-123", "Ω", ""]) expect(collaboratorColor(id)).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("is stable for an id and varies across ids", () => {
    expect(collaboratorColor("alice")).toBe(collaboratorColor("alice"));
    const colours = new Set(Array.from({ length: 40 }, (_, i) => collaboratorColor(`user-${i}`)));
    expect(colours.size).toBeGreaterThan(6);
  });
});

describe("safeColor", () => {
  it("keeps a plain hex colour from another collaborator", () => {
    expect(safeColor("#12abEF", "x")).toBe("#12abEF");
  });

  it.each(["url(https://evil.example/track)", "red; background: url(x)", "#12ab", "hsl(1 2% 3%)", 42, null])(
    "replaces %j with the sender's own derived colour",
    (hostile) => {
      expect(safeColor(hostile, "bob")).toBe(collaboratorColor("bob"));
    },
  );
});
