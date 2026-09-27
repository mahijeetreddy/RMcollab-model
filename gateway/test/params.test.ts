import type { Request } from "express";
import { describe, expect, it } from "vitest";
import { routeParam } from "../src/http/params.js";

const fakeRequest = (params: Record<string, string>): Request =>
  ({ params, path: "/rooms/r1" }) as unknown as Request;

describe("routeParam", () => {
  it("returns a bound param", () => {
    expect(routeParam(fakeRequest({ roomId: "r1" }), "roomId")).toBe("r1");
  });

  it("throws, naming the param and path, when it is missing", () => {
    expect(() => routeParam(fakeRequest({}), "roomId")).toThrow(
      "route param :roomId missing on /rooms/r1",
    );
  });
});
