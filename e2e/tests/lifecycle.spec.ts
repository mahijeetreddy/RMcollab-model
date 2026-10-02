import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { API, createSession, json, Participant, uploadFile, uploadText, waitForStrategy } from "../helpers.js";

/** Limits, deletion, renaming, retrying and expiry, against the live stack. */

const COMPOSE = fileURLToPath(new URL("../../infra/docker-compose.yml", import.meta.url));
const compose = (...args: string[]) =>
  execFileSync("docker", ["compose", "-f", COMPOSE, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sql = (query: string) => compose("exec", "-T", "postgres", "psql", "-U", "rmcollab", "-d", "rmcollab", "-Atc", query).trim();

async function status(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${API}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}
const patch = (body: unknown): RequestInit => ({
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test.describe("limits", () => {
  test("one person's uploads are limited per minute, with a message that says so", async () => {
    const { session, rooms } = await createSession("limits");
    const alice = await Participant.join(session.code, "Alice");
    const results: number[] = [];
    let refusal: Record<string, unknown> = {};
    for (let i = 0; i < 11; i += 1) {
      const r = await status(`/api/rooms/${rooms[0]!.id}/media`, post({ participantId: alice.id, text: `note ${i}`, strategy: "rulebased" }));
      results.push(r.status);
      if (r.status === 429) refusal = r.body;
    }
    expect(results.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(results[10]).toBe(429);
    expect(String(refusal["message"])).toMatch(/a lot of uploads in a minute/);
    expect(refusal["retryAfterS"]).toBeGreaterThan(0);
    // Someone else in the same session still can.
    const bob = await Participant.join(session.code, "Bob");
    expect((await status(`/api/rooms/${rooms[0]!.id}/media`, post({ participantId: bob.id, text: "mine", strategy: "rulebased" }))).status).toBe(201);
    alice.close();
    bob.close();
  });
});

test.describe("managing uploads", () => {
  test("only whoever added an upload can delete it; its files and results go, and the room hears", async () => {
    const { session, rooms } = await createSession("delete");
    const roomId = rooms[0]!.id;
    const alice = await Participant.join(session.code, "Alice");
    const bob = await Participant.join(session.code, "Bob");
    const { job } = await uploadText(roomId, alice.id, "the albatross circled the harbour", "rulebased");
    const mediaItemId = (job as unknown as { mediaItemId: string }).mediaItemId;
    const done = await alice.waitFor((e) => e.type === "job_complete" && e.status === "done", 60_000);
    const resultUrl = ((done.artifacts as { url: string }[])[0]!).url;
    expect((await fetch(resultUrl)).status).toBe(200);

    const bobTries = await status(`/api/rooms/${roomId}/media/${mediaItemId}?participantId=${bob.id}`, { method: "DELETE" });
    expect(bobTries.status).toBe(403);

    const aliceDeletes = await status(`/api/rooms/${roomId}/media/${mediaItemId}?participantId=${alice.id}`, { method: "DELETE" });
    expect(aliceDeletes.status).toBe(204);
    await bob.waitFor((e) => e.type === "media_deleted" && e.mediaItemId === mediaItemId);
    // The files are gone, and so is the searchable text.
    expect((await fetch(resultUrl)).status).toBe(404);
    const { entries } = await json<{ entries: unknown[] }>(`/api/rooms/${roomId}/library?participantId=${alice.id}&q=albatross`);
    expect(entries).toEqual([]);
    alice.close();
    bob.close();
  });

  test("renaming reaches the room, and a text upload is titled by its first words", async () => {
    const { session, rooms } = await createSession("rename");
    const roomId = rooms[0]!.id;
    const alice = await Participant.join(session.code, "Alice");
    const created = await status(
      `/api/rooms/${roomId}/media`,
      post({ participantId: alice.id, text: "Week 6 meeting notes\nWe chose Redis Streams.", strategy: "rulebased" }),
    );
    const item = created.body["mediaItem"] as { id: string; title: string | null };
    expect(item.title).toBe("Week 6 meeting notes");

    const renamed = await status(`/api/rooms/${roomId}/media/${item.id}`, patch({ participantId: alice.id, title: "  Broker decision  " }));
    expect(renamed.status).toBe(200);
    const update = await alice.waitFor((e) => e.type === "media_updated");
    expect((update.mediaItem as { title: string }).title).toBe("Broker decision");
    await alice.waitFor((e) => e.type === "job_complete", 60_000);
    const { entries } = await json<{ entries: { title: string | null }[] }>(`/api/rooms/${roomId}/library?participantId=${alice.id}`);
    expect(entries[0]!.title).toBe("Broker decision");
    alice.close();
  });

  test("a failed upload can be retried, which queues a new job for it", async () => {
    test.setTimeout(240_000);
    await waitForStrategy("video", "comprehend");
    const { session, rooms } = await createSession("retry");
    const roomId = rooms[0]!.id;
    const alice = await Participant.join(session.code, "Alice");
    // A video with no soundtrack cannot be transcribed: a reliable failure.
    const { job } = await uploadFile(roomId, alice.id, "silent.mp4", "video/mp4", "comprehend");
    const mediaItemId = (job as unknown as { mediaItemId: string }).mediaItemId;
    await alice.waitFor((e) => e.type === "job_complete" && e.status === "failed", 180_000);

    const retried = await status(`/api/rooms/${roomId}/media/${mediaItemId}/retry`, post({ participantId: alice.id }));
    expect(retried.status).toBe(201);
    const newJob = retried.body["job"] as { id: string; status: string };
    expect(newJob.id).not.toBe(job.id);
    const update = await alice.waitFor((e) => e.type === "media_updated" && (e.job as { id: string } | undefined)?.id === newJob.id);
    expect((update.job as { status: string }).status).toBe("queued");

    // Only a failed upload can be retried.
    const done = await uploadText(roomId, alice.id, "fine", "rulebased");
    await alice.waitFor((e) => e.type === "job_complete" && e.jobId === done.job.id, 60_000);
    const notFailed = await status(
      `/api/rooms/${roomId}/media/${(done.job as unknown as { mediaItemId: string }).mediaItemId}/retry`,
      post({ participantId: alice.id }),
    );
    expect(notFailed.status).toBe(409);
    alice.close();
  });
});

test.describe("rooms", () => {
  test("a breakout room can be deleted by its owner only, and never the main room", async () => {
    const { session, rooms } = await createSession("rooms");
    const alice = await Participant.join(session.code, "Alice");
    const bob = await Participant.join(session.code, "Bob");
    const { room } = await json<{ room: { id: string } }>(`/api/sessions/${session.code}/rooms`, post({ name: "Group A", participantId: alice.id }));

    expect((await status(`/api/rooms/${room.id}?participantId=${bob.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await status(`/api/rooms/${rooms[0]!.id}?participantId=${alice.id}`, { method: "DELETE" })).status).toBe(400);
    expect((await status(`/api/rooms/${room.id}?participantId=${alice.id}`, { method: "DELETE" })).status).toBe(204);

    const update = await bob.waitFor(
      (e) => e.type === "rooms_updated" && !(e.rooms as { id: string }[]).some((r) => r.id === room.id),
    );
    expect((update.rooms as unknown[]).length).toBe(1);
    alice.close();
    bob.close();
  });
});

test.describe("expiry", () => {
  test("a session nobody has touched for three days is deleted with its files", async () => {
    const { session, rooms } = await createSession("expiry");
    const alice = await Participant.join(session.code, "Alice");
    const { job } = await uploadText(rooms[0]!.id, alice.id, "old notes", "rulebased");
    const done = await alice.waitFor((e) => e.type === "job_complete" && e.jobId === job.id, 60_000);
    const fileUrl = ((done.artifacts as { url: string }[])[0]!).url;
    alice.close();
    // Disconnected, and last active four days ago.
    await expect.poll(() => sql(`SELECT connected FROM participants WHERE id = '${alice.id}'`)).toBe("f");
    sql(`UPDATE sessions SET last_active_at = ${Date.now() - 4 * 24 * 3600 * 1000} WHERE id = '${session.id}'`);

    // The gateway's own sweep, as it runs hourly.
    compose("exec", "-T", "gateway", "node", "--input-type=module", "-e", "const { sweep } = await import('./dist/lifecycle.js'); console.log(JSON.stringify(await sweep()));");

    expect(sql(`SELECT count(*) FROM sessions WHERE id = '${session.id}'`)).toBe("0");
    expect((await status(`/api/sessions/${session.code}`)).status).toBe(404);
    expect((await fetch(fileUrl)).status).toBe(404);
  });

  test("an active session is left alone", async () => {
    const { session } = await createSession("active");
    compose("exec", "-T", "gateway", "node", "--input-type=module", "-e", "const { sweep } = await import('./dist/lifecycle.js'); await sweep();");
    expect(sql(`SELECT count(*) FROM sessions WHERE id = '${session.id}'`)).toBe("1");
  });

  test("a session its owner chose to keep lasts 30 quiet days, not 3", async () => {
    const { session } = await createSession("kept");
    const owner = await Participant.join(session.code, "Owner");
    const member = await Participant.join(session.code, "Member");
    // Only the owner may choose; the choice is the session's, for everyone to see.
    expect((await status(`/api/sessions/${session.code}`, patch({ participantId: member.id, kept: true }))).status).toBe(403);
    const kept = await status(`/api/sessions/${session.code}`, patch({ participantId: owner.id, kept: true }));
    expect(kept.status).toBe(200);
    expect((kept.body.session as { kept: boolean; retentionDays: number })).toMatchObject({ kept: true, retentionDays: 30 });
    await member.waitFor((e) => e.type === "session_updated" && (e.session as { kept: boolean }).kept);
    owner.close();
    member.close();
    await expect.poll(() => sql(`SELECT count(*) FROM participants WHERE session_id = '${session.id}' AND connected`)).toBe("0");

    const sweep = () =>
      compose("exec", "-T", "gateway", "node", "--input-type=module", "-e", "const { sweep } = await import('./dist/lifecycle.js'); await sweep();");
    const idleFor = (days: number) => sql(`UPDATE sessions SET last_active_at = ${Date.now() - days * 24 * 3600 * 1000} WHERE id = '${session.id}'`);
    idleFor(4);
    sweep();
    expect(sql(`SELECT count(*) FROM sessions WHERE id = '${session.id}'`)).toBe("1");
    idleFor(31);
    sweep();
    expect(sql(`SELECT count(*) FROM sessions WHERE id = '${session.id}'`)).toBe("0");
  });
});

test.describe("fair queueing", () => {
  test("a session's backlog does not hold up another session's job", async () => {
    test.setTimeout(150_000);
    // With the text pool stopped, jobs pile up: session A drops in four, then
    // B one. In arrival order B would wait behind all four; taking turns, it
    // goes to the pool before A's third.
    compose("stop", "text-worker");
    try {
      const a = await createSession("fair-a");
      const b = await createSession("fair-b");
      const alice = await Participant.join(a.session.code, "Alice");
      const bob = await Participant.join(b.session.code, "Bob");
      const aJobs: string[] = [];
      for (let i = 1; i <= 4; i += 1) aJobs.push((await uploadText(a.rooms[0]!.id, alice.id, `lecture ${i} notes`, "rulebased")).job.id);
      const bJob = (await uploadText(b.rooms[0]!.id, bob.id, "our only upload", "rulebased")).job.id;

      compose("start", "text-worker");
      // Done in the order the pool was handed them; read that order back.
      await expect
        .poll(() => sql(`SELECT count(*) FROM enhancement_jobs WHERE id IN ('${[...aJobs, bJob].join("','")}') AND status = 'done'`), {
          timeout: 120_000,
        })
        .toBe("5");
      const order = sql(
        `SELECT id FROM enhancement_jobs WHERE id IN ('${[...aJobs, bJob].join("','")}') ORDER BY dispatched_at, created_at`,
      ).split("\n");
      // A's first ones may have gone before B arrived; B's goes before A's third.
      expect(order.indexOf(bJob)).toBeLessThan(order.indexOf(aJobs[2]!));
      alice.close();
      bob.close();
    } finally {
      compose("start", "text-worker");
    }
  });
});
