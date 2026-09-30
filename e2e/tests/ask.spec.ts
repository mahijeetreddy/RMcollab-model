import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createSession, Participant, uploadText, type ServerEvent } from "../helpers.js";

interface Source {
  n: number;
  kind: string;
  mediaItemId: string | null;
  atSeconds: number | null;
  notesKey: string | null;
}

interface Answer {
  sources: Source[];
  text: string;
  done: ServerEvent & { cited: number[]; fallback?: string; noEvidence?: boolean; model?: string };
}

/** Asks over the real socket and gathers the reply: sources, streamed text, the end. */
async function ask(
  participant: Participant,
  roomId: string,
  question: string,
  timeoutMs = 60_000,
  history: { question: string; answer: string }[] = [],
): Promise<Answer> {
  const requestId = randomUUID();
  participant.send({ type: "ask", roomId, requestId, question, ...(history.length ? { history } : {}) });
  const done = (await participant.waitFor((e) => e.type === "ask_done" && e.requestId === requestId, timeoutMs)) as Answer["done"];
  const mine = participant.events.filter((e) => e.requestId === requestId);
  const sources = (mine.find((e) => e.type === "ask_sources")?.sources ?? []) as Source[];
  const text = mine
    .filter((e) => e.type === "ask_delta")
    .map((e) => e.text as string)
    .join("");
  return { sources, text, done };
}

const fixture = async () =>
  JSON.parse(await readFile(new URL("../fixtures/ask-eval.json", import.meta.url), "utf8")) as {
    passages: { id: string; text: string }[];
    questions: { q: string; gold: string[] }[];
    followUps: { q: string; gold: string[]; history: { question: string; answer: string }[] }[];
  };

test.describe("ask the room", () => {
  test("finds the passage that answers a paraphrased question, and cites only what it was given", async () => {
    test.setTimeout(420_000);
    const { passages, questions, followUps } = await fixture();
    const { session, rooms } = await createSession("ask eval");
    const roomId = rooms[0]!.id;
    const uploader = await Participant.join(session.code, "Alice");

    // Each passage is its own document, so a source's upload says which passage it is.
    // Several uploaders, because one person may add only so many a minute.
    const byMedia = new Map<string, string>();
    const uploaders = [uploader];
    for (const [i, passage] of passages.entries()) {
      if (i > 0 && i % 8 === 0) uploaders.push(await Participant.join(session.code, `Uploader ${i / 8 + 1}`));
      const { job } = await uploadText(roomId, uploaders.at(-1)!.id, passage.text, "rulebased");
      byMedia.set((job as unknown as { mediaItemId: string }).mediaItemId, passage.id);
    }
    await expect
      .poll(() => uploader.events.filter((e) => e.type === "job_complete" && e.status === "done").length, { timeout: 120_000 })
      .toBe(passages.length);

    // Embeddings land asynchronously after each job; asking before they have
    // would measure keyword search alone. Wait until a question that shares no
    // word with its answer ("exam" / "midterm") is answered.
    const probe = questions.find((q) => q.q.startsWith("When is the exam"))!;
    await expect
      .poll(
        async () => {
          const asker = await Participant.join(session.code, `probe-${randomUUID().slice(0, 6)}`);
          const { sources } = await ask(asker, roomId, probe.q);
          asker.close();
          return sources.slice(0, 3).some((s) => probe.gold.includes(byMedia.get(s.mediaItemId ?? "") ?? ""));
        },
        { timeout: 120_000, intervals: [3000] },
      )
      .toBe(true);

    // Several askers, because each person is limited to a few questions a minute.
    const askers: Participant[] = [];
    let top1 = 0;
    let top3 = 0;
    const misses: string[] = [];
    for (const [i, item] of questions.entries()) {
      if (i % 5 === 0) askers.push(await Participant.join(session.code, `Asker ${i / 5 + 1}`));
      const { sources, text, done } = await ask(askers.at(-1)!, roomId, item.q);
      const rank = sources.findIndex((s) => item.gold.includes(byMedia.get(s.mediaItemId ?? "") ?? "")) + 1;
      if (rank === 1) top1 += 1;
      if (rank >= 1 && rank <= 3) top3 += 1;
      else misses.push(`${item.q} (rank ${rank || "none"})`);

      // Whatever the model wrote, every citation it keeps points at a real source.
      for (const n of done.cited) expect(sources.map((s) => s.n)).toContain(n);
      if (!done.fallback) expect(text.length).toBeGreaterThan(0);
    }
    console.log(
      `[ask eval] hybrid retrieval over ${questions.length} questions: ` +
        `top-1 ${(top1 / questions.length).toFixed(2)}, top-3 ${(top3 / questions.length).toFixed(2)}` +
        (misses.length ? `; missed: ${misses.join("; ")}` : ""),
    );
    // Vector search alone reached 1.00 top-3 on this set (workers/tools/eval_embeddings.py);
    // the merged ranking must not do worse than that by more than one question.
    expect(top3).toBeGreaterThanOrEqual(questions.length - 1);

    // Follow-ups only make sense after their earlier turn; they are rewritten
    // to stand alone before searching.
    let followTop3 = 0;
    const followMisses: string[] = [];
    const followAsker = await Participant.join(session.code, "Follow-up asker");
    askers.push(followAsker);
    for (const item of followUps) {
      const { sources } = await ask(followAsker, roomId, item.q, 60_000, item.history);
      const rewritten = followAsker.events.find((e) => e.type === "ask_sources" && e.sources === sources)?.standalone;
      const rank = sources.findIndex((s) => item.gold.includes(byMedia.get(s.mediaItemId ?? "") ?? "")) + 1;
      if (rank >= 1 && rank <= 3) followTop3 += 1;
      else followMisses.push(`${item.q} -> ${String(rewritten ?? "(not rewritten)")} (rank ${rank || "none"})`);
    }
    console.log(
      `[ask eval] follow-ups: top-3 ${(followTop3 / followUps.length).toFixed(2)}` +
        (followMisses.length ? `; missed: ${followMisses.join("; ")}` : ""),
    );
    expect(followTop3).toBeGreaterThanOrEqual(followUps.length - 1);
    for (const p of [...uploaders, ...askers]) p.close();
  });

  test("an answer streams with citations that point at real sources, recordings with a time", async () => {
    test.setTimeout(180_000);
    const { session, rooms } = await createSession("ask answer");
    const roomId = rooms[0]!.id;
    const alice = await Participant.join(session.code, "Alice");
    await uploadText(
      roomId,
      alice.id,
      "We compared Kafka and Redis Streams. We decided on Redis Streams, because nobody wants to run ZooKeeper for a class project.",
      "rulebased",
    );
    await alice.waitFor((e) => e.type === "job_complete" && e.status === "done", 60_000);

    const answer = await expect
      .poll(async () => (await ask(alice, roomId, "Which message broker did we choose, and why?")).sources.length, { timeout: 60_000 })
      .toBeGreaterThan(0)
      .then(() => ask(alice, roomId, "Which message broker did we choose, and why?"));
    test.skip(answer.done.fallback === "no_model", "no language model configured: sources only");
    test.skip(answer.done.fallback === "quota", "the model's quota is spent for today");
    expect(answer.done.fallback).toBeUndefined();
    // \s, not a space: models often write a non-breaking one between words.
    expect(answer.text).toMatch(/Redis\s+Streams/i);
    expect(answer.done.cited.length).toBeGreaterThan(0);
    expect(answer.text).toMatch(/\[\d\]/);
    alice.close();
  });

  test("a room with nothing in it says so, without calling a model", async () => {
    const { session, rooms } = await createSession("ask empty");
    const alice = await Participant.join(session.code, "Alice");
    const { done, sources } = await ask(alice, rooms[0]!.id, "What did we decide?");
    expect(done.noEvidence).toBe(true);
    expect(sources).toEqual([]);
    alice.close();
  });

  test("questions are private to the room you are in, and limited per minute", async () => {
    const { session, rooms } = await createSession("ask limits");
    const other = await createSession("someone else");
    const alice = await Participant.join(session.code, "Alice");
    const bob = await Participant.join(session.code, "Bob");

    // A room you have not joined is refused outright.
    alice.send({ type: "ask", roomId: other.rooms[0]!.id, requestId: randomUUID(), question: "anything?" });
    await alice.waitFor((e) => e.type === "error" && e.code === "not_in_room");

    // The answer goes only to the asker.
    const mine = await ask(alice, rooms[0]!.id, "What did we decide?");
    expect(bob.events.some((e) => e.type.startsWith("ask_"))).toBe(false);

    // Six a minute; the seventh is turned away (an empty room answers without a model).
    const results = [mine];
    for (let i = 0; i < 6; i += 1) results.push(await ask(alice, rooms[0]!.id, `Question ${i}?`));
    expect(results.slice(0, 6).every((r) => r.done.fallback !== "rate_limited")).toBe(true);
    expect(results[6]!.done.fallback).toBe("rate_limited");
    alice.close();
    bob.close();
  });
});
