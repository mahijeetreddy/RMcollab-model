import { expect, test } from "@playwright/test";
import {
  API,
  createSession,
  json,
  Participant,
  uploadFile,
  uploadText,
  waitForStrategy,
} from "../helpers.js";

interface Entry {
  artifact: { id: string; kind: string; mimeType: string | null } & Record<string, unknown>;
  mediaItemId: string;
  snippet: string | null;
  atSeconds: number | null;
}

const START = "\u0002";
const END = "\u0003";

const library = (roomId: string, participantId: string, q?: string) =>
  json<{ entries: Entry[]; query: string | null }>(
    `/api/rooms/${roomId}/library?participantId=${encodeURIComponent(participantId)}${
      q ? `&q=${encodeURIComponent(q)}` : ""
    }`,
  );

test.describe("room library", () => {
  test("a finished document is searchable by stem, with marked matches", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    await uploadText(rooms[0]!.id, alice.id, "the pelicans migrated south", "rulebased");
    await alice.waitFor((e) => e.type === "job_complete");

    const all = await library(rooms[0]!.id, alice.id);
    expect(all.entries).toHaveLength(1);
    // The worker now reports what it wrote, which is what makes it indexable.
    expect(all.entries[0]!.artifact.mimeType).toBe("text/plain");

    // "pelican" finds "pelicans": English stemming, not substring matching.
    const { entries } = await library(rooms[0]!.id, alice.id, "pelican");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.snippet).toContain(`${START}pelicans${END}`);

    expect((await library(rooms[0]!.id, alice.id, "walrus")).entries).toEqual([]);
    alice.close();
  });

  test("the full text never leaks into job events or room snapshots", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    await uploadText(rooms[0]!.id, alice.id, "keep this body server side", "rulebased");
    const done = await alice.waitFor((e) => e.type === "job_complete");
    const later = await Participant.join(session.code, "Later");
    const snapshot = await later.waitFor((e) => e.type === "room_state");

    const media = snapshot.media as { job: { artifacts: Record<string, unknown>[] } }[];
    for (const artifact of [...(done.artifacts as Record<string, unknown>[]), ...media[0]!.job.artifacts]) {
      expect(Object.keys(artifact)).not.toContain("body");
      expect(Object.keys(artifact)).not.toContain("search");
    }
    alice.close();
    later.close();
  });

  test("search is scoped to the room, and a locked room's library is private", async () => {
    const { session, rooms } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    const outsider = await Participant.join(session.code, "Outsider");
    const { room } = await json<{ room: { id: string } }>(`/api/sessions/${session.code}/rooms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Private", accessCode: "HUSH1", participantId: owner.id }),
    });
    owner.send({ type: "join_room", roomId: room.id });
    await owner.waitFor((e) => e.type === "room_state" && e.roomId === room.id);

    await uploadText(room.id, owner.id, "the secret heron plan", "rulebased");
    await owner.waitFor((e) => e.type === "job_complete");

    expect((await library(room.id, owner.id, "heron")).entries).toHaveLength(1);
    // The main room shares the session but not the document.
    expect((await library(rooms[0]!.id, outsider.id, "heron")).entries).toEqual([]);

    const denied = await fetch(`${API}/api/rooms/${room.id}/library?participantId=${outsider.id}`);
    expect(denied.status).toBe(403);
    const anonymous = await fetch(`${API}/api/rooms/${room.id}/library`);
    expect(anonymous.status).toBe(400);

    owner.close();
    outsider.close();
  });

  test("hostile search syntax degrades to a search, not an error", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    for (const q of ["'); DROP TABLE job_artifacts; --", "a & | ! ( :*", '"unclosed', "the"]) {
      const { entries } = await library(rooms[0]!.id, alice.id, q);
      expect(Array.isArray(entries)).toBe(true);
    }
    alice.close();
  });

  test("a transcript hit says when in the recording it is spoken", async () => {
    await waitForStrategy("audio", "comprehend");
    const { session, rooms } = await createSession();
    const student = await Participant.join(session.code, "Student");
    await uploadFile(rooms[0]!.id, student.id, "lecture.mp3", "audio/mpeg");
    await student.waitFor((e) => e.type === "job_complete", 150_000);

    const { entries } = await library(rooms[0]!.id, student.id, "gateway");
    const hit = entries.find((e) => e.artifact.kind === "transcript");
    expect(hit, "the transcript should match a word spoken in the lecture").toBeTruthy();
    // "gateway" is in the first sentence; the stamp comes from the matching line.
    expect(hit!.atSeconds).not.toBeNull();
    expect(hit!.atSeconds!).toBeLessThan(10);
    student.close();
  });
});
