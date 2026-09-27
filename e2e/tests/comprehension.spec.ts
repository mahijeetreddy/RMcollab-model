import { expect, test } from "@playwright/test";
import { createSession, Participant, uploadFile, waitForStrategy } from "../helpers.js";

interface Artifact {
  kind: string;
  url: string;
  mimeType: string | null;
  meta: Record<string, unknown>;
}

test.describe("audio comprehension", () => {
  test("a recording becomes a timestamped transcript by default", async () => {
    await waitForStrategy("audio", "comprehend");
    const { session, rooms } = await createSession();
    const student = await Participant.join(session.code, "Student");

    // No strategy named: the room gets whatever the audio default is, which
    // should be comprehension rather than bare noise reduction.
    await uploadFile(rooms[0]!.id, student.id, "lecture.mp3", "audio/mpeg");
    const done = await student.waitFor((e) => e.type === "job_complete", 150_000);
    expect(done.status).toBe("done");

    const artifacts = done.artifacts as Artifact[];
    const transcript = artifacts.find((a) => a.kind === "transcript");
    expect(transcript, "comprehension must always produce a transcript").toBeTruthy();
    expect(transcript!.mimeType).toBe("text/plain");
    // Denoising is off by default because it measurably raised word error rate.
    expect(transcript!.meta.denoised).toBe(false);

    const text = (await (await fetch(transcript!.url)).text()).toLowerCase();
    expect(text).toMatch(/^\[\d\d:\d\d:\d\d\]/);
    for (const word of ["distributed", "systems", "queues", "gateway"]) {
      expect(text).toContain(word);
    }

    // A summary appears only when a language model is configured, and its
    // absence must not fail the job.
    const summary = artifacts.find((a) => a.kind === "summary");
    if (summary) expect(summary.mimeType).toBe("text/markdown");

    student.close();
  });

  test("a lecture video is transcribed from its soundtrack by default", async () => {
    // Video comprehension runs in the audio pool, next to Whisper; the gateway
    // routes it there from the capability adverts rather than by media type.
    await waitForStrategy("video", "comprehend");
    const { session, rooms } = await createSession();
    const student = await Participant.join(session.code, "Student");

    await uploadFile(rooms[0]!.id, student.id, "lecture.mp4", "video/mp4");
    const done = await student.waitFor((e) => e.type === "job_complete", 150_000);
    expect(done.status).toBe("done");

    const transcript = (done.artifacts as Artifact[]).find((a) => a.kind === "transcript");
    expect(transcript, "a video's default is now a transcript, not an upscale").toBeTruthy();
    const text = (await (await fetch(transcript!.url)).text()).toLowerCase();
    for (const word of ["distributed", "queues", "gateway"]) expect(text).toContain(word);
    student.close();
  });

  test("a video with no soundtrack fails with a plain reason", async () => {
    await waitForStrategy("video", "comprehend");
    const { session, rooms } = await createSession();
    const student = await Participant.join(session.code, "Student");

    await uploadFile(rooms[0]!.id, student.id, "silent.mp4", "video/mp4", "comprehend");
    const done = await student.waitFor((e) => e.type === "job_complete", 60_000);
    expect(done.status).toBe("failed");
    expect(String(done.error)).toMatch(/no soundtrack/i);
    student.close();
  });

  test("naming an upscaling strategy still sends video to the video pool", async () => {
    // Routing by capability must not turn into "all video goes to audio".
    await waitForStrategy("video", "classical");
    const { session, rooms } = await createSession();
    const student = await Participant.join(session.code, "Student");

    await uploadFile(rooms[0]!.id, student.id, "silent.mp4", "video/mp4", "classical");
    const done = await student.waitFor((e) => e.type === "job_complete", 120_000);
    expect(done.status).toBe("done");
    expect((done.artifacts as Artifact[]).map((a) => a.kind)).toEqual(["enhanced"]);
    student.close();
  });
});
