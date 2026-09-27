import { expect, test } from "@playwright/test";
import { API, createSession, Participant, uploadText } from "../helpers.js";

interface Artifact {
  kind: string;
  url: string;
}

test.describe("job pipeline", () => {
  test("a text job fans out to every socket in the room", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    const bob = await Participant.join(session.code, "Bob");

    await uploadText(rooms[0]!.id, alice.id, "teh cat sat on teh mat", "rulebased");

    // Bob never touched the job, so these can only reach him through the
    // gateway's Redis fan-out - which is what makes multiple replicas work.
    for (const who of [alice, bob]) {
      await who.waitFor((e) => e.type === "media_uploaded");
      const done = await who.waitFor((e) => e.type === "job_complete");
      expect(done.status).toBe("done");
    }
    alice.close();
    bob.close();
  });

  test("the result is a signed artifact with the enhanced content", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");

    await uploadText(rooms[0]!.id, alice.id, "teh artifact model works", "rulebased");
    const done = await alice.waitFor((e) => e.type === "job_complete");
    const artifacts = done.artifacts as Artifact[];

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]!.kind).toBe("enhanced");
    expect(artifacts[0]!.url).toMatch(/[?&]sig=[0-9a-f]+/);
    expect(await (await fetch(artifacts[0]!.url)).text()).toBe("The artifact model works.\n");
    alice.close();
  });

  test("artifacts come back in the snapshot when someone rejoins", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    await uploadText(rooms[0]!.id, alice.id, "persist me", "rulebased");
    await alice.waitFor((e) => e.type === "job_complete");
    alice.close();

    const later = await Participant.join(session.code, "Later");
    const snapshot = await later.waitFor((e) => e.type === "room_state");
    const media = snapshot.media as { job: { artifacts: Artifact[] } }[];
    expect(media[0]!.job.artifacts.map((a) => a.kind)).toEqual(["enhanced"]);
    later.close();
  });
});

test.describe("media access", () => {
  test("a stored file cannot be fetched without its signature", async () => {
    const { session, rooms } = await createSession();
    const alice = await Participant.join(session.code, "Alice");
    await uploadText(rooms[0]!.id, alice.id, "private notes", "rulebased");
    const done = await alice.waitFor((e) => e.type === "job_complete");
    const signed = (done.artifacts as Artifact[])[0]!.url;
    alice.close();

    expect((await fetch(signed)).status).toBe(200);
    expect((await fetch(signed.split("?")[0]!)).status).toBe(403);
    expect((await fetch(signed.replace(/sig=[0-9a-f]{8}/, "sig=deadbeef"))).status).toBe(403);
  });

  test("path traversal out of storage is refused", async () => {
    const response = await fetch(`${API}/files/..%2F..%2Fetc%2Fpasswd?exp=9999999999&sig=x`);
    expect([400, 403]).toContain(response.status);
  });
});
