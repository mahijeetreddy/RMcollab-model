import { describe, expect, it } from "vitest";
import { redactCodes, scrubEvent } from "@rmcollab/shared";

describe("scrubEvent", () => {
  it("blanks session codes, with or without the dash, and leaves ids alone", () => {
    expect(redactCodes("No session with code ABCDE-23456 (ABCDE23456)")).toBe("No session with code [code] ([code])");
    expect(redactCodes("job V1StGXR8_Z5jdHi6B-myT failed")).toBe("job V1StGXR8_Z5jdHi6B-myT failed");
  });

  it("keeps where it broke, and drops what anyone wrote or who they are", () => {
    const event = scrubEvent({
      user: { username: "Alice" },
      extra: { arguments: ["[docs] relay failed", "the notes"] },
      request: {
        url: "http://localhost:4000/api/sessions/ABCDE23456/waiting?participantId=p1",
        data: { text: "the notes" },
        headers: { cookie: "x" },
        query_string: "participantId=p1",
      },
      exception: {
        values: [
          { value: "No session ABCDE23456", stacktrace: { frames: [{ function: "join", vars: { body: "the notes" } }] } },
        ],
      },
      breadcrumbs: [
        { category: "ui.click", message: 'button[aria-label="Remove Bob"]' },
        { category: "console", message: "the notes" },
        { category: "fetch", data: { url: "/api/sessions/ABCDE-23456?participantId=p1", method: "GET" } },
      ],
    });
    expect(event.request).toEqual({ url: "http://localhost:4000/api/sessions/[code]/waiting" });
    expect(event.exception.values[0]).toEqual({ value: "No session [code]", stacktrace: { frames: [{ function: "join" }] } });
    expect(event.breadcrumbs).toEqual([
      { category: "fetch", message: undefined, data: { url: "/api/sessions/[code]", method: "GET" } },
    ]);
    expect(JSON.stringify(event)).not.toMatch(/Alice|Bob|the notes|p1/);
  });
});
