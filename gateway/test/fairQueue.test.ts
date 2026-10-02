import { describe, expect, it } from "vitest";
import { fairOrder } from "../src/queue/fair.js";

const job = (id: string, sessionId: string, createdAt: number) => ({ id, sessionId, createdAt });
const ids = (jobs: { id: string }[]) => jobs.map((j) => j.id);

describe("fairOrder", () => {
  it("takes turns between sessions instead of serving the first one's whole backlog", () => {
    // Session A dropped in four lectures, then B and C one each.
    const waiting = [
      job("a1", "A", 1),
      job("a2", "A", 2),
      job("a3", "A", 3),
      job("a4", "A", 4),
      job("b1", "B", 5),
      job("c1", "C", 6),
    ];
    expect(ids(fairOrder(waiting, new Map()))).toEqual(["a1", "b1", "c1", "a2", "a3", "a4"]);
  });

  it("counts what a session already has running", () => {
    // A already has two in the pool; B has none, so B goes first.
    const waiting = [job("a3", "A", 1), job("b1", "B", 2), job("b2", "B", 3)];
    expect(ids(fairOrder(waiting, new Map([["A", 2]])))).toEqual(["b1", "b2", "a3"]);
  });

  it("is first come first served within a session, and between equals", () => {
    const waiting = [job("b1", "B", 2), job("a1", "A", 1), job("a2", "A", 3)];
    expect(ids(fairOrder(waiting, new Map()))).toEqual(["a1", "b1", "a2"]);
  });

  it("breaks a tie in favour of the session served longest ago", () => {
    // A's earlier jobs already finished (nothing in flight), so its next job
    // ties with B's first; A was just served, B never - B goes first.
    const waiting = [job("a3", "A", 3), job("b1", "B", 5)];
    expect(ids(fairOrder(waiting, new Map(), new Map([["A", 100]])))).toEqual(["b1", "a3"]);
  });
});
