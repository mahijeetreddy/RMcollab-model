import { expect, test } from "@playwright/test";
import { createSession, Participant, uploadFile, waitForStrategy } from "../helpers.js";

/**
 * A whiteboard photo read into notes by the configured vision model.
 *
 * Opt-in (E2E_VISION=1): it calls a real vision API, and on a free tier each
 * run spends part of a small daily quota - Gemini allows 20 requests a day.
 */
test.skip(!process.env.E2E_VISION, "set E2E_VISION=1 to spend a vision API call on this");

test("a whiteboard photo becomes faithful notes, with its to-dos as a checklist", async () => {
  test.setTimeout(180_000);
  await waitForStrategy("image", "notes");
  const { session, rooms } = await createSession();
  const alice = await Participant.join(session.code, "Alice");

  // No strategy named: reading into notes is the image default.
  await uploadFile(rooms[0]!.id, alice.id, "whiteboard.jpg", "image/jpeg");
  const done = await alice.waitFor((e) => e.type === "job_complete", 150_000);
  expect(done.status).toBe("done");

  const notes = (done.artifacts as { label: string; url: string }[]).find((a) => a.label === "Notes");
  expect(notes).toBeTruthy();
  const text = await (await fetch(notes!.url)).text();
  // Specifics written on the board survive exactly - the figure, the command,
  // the owners - and the written TODOs become action items.
  for (const exact of ["XAUTOCLAIM", "91.7", "ZooKeeper", "Priya", "Marcus"]) expect(text).toContain(exact);
  expect(text).toMatch(/## Action items/i);
  alice.close();
});
