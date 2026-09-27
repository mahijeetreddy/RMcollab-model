import { expect, test } from "@playwright/test";
import { API, createSession, json, Participant } from "../helpers.js";

interface Room {
  id: string;
  isLocked: boolean;
  ownerId: string | null;
}

async function lockedRoom(code: string, ownerId: string, accessCode = "HUSH1") {
  return json<{ room: Room }>(`/api/sessions/${code}/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Group A", accessCode, participantId: ownerId }),
  });
}

test.describe("private breakout rooms", () => {
  test("a locked room admits only the right code, and remembers it", async () => {
    const { session } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    const { room } = await lockedRoom(session.code, owner.id);
    const guest = await Participant.join(session.code, "Guest");

    const attempt = async (code?: string) => {
      const from = guest.events.length;
      guest.send({ type: "join_room", roomId: room.id, ...(code ? { code } : {}) });
      return guest.waitFor(
        (e) =>
          guest.events.indexOf(e) >= from &&
          (e.type === "error" || (e.type === "room_state" && e.roomId === room.id)),
      );
    };

    expect((await attempt()).code).toBe("room_locked");
    expect((await attempt("WRONG")).code).toBe("room_code_invalid");
    expect((await attempt("HUSH1")).type).toBe("room_state");
    // A reconnect or room switch must not ask for the code again.
    expect((await attempt()).type).toBe("room_state");

    owner.close();
    guest.close();
  });

  test("the creator is admitted to their own locked room", async () => {
    // Regression: setting a code used to lock its own creator out, prompting
    // them for the code they had just typed.
    const { session } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    const { room } = await lockedRoom(session.code, owner.id);

    owner.send({ type: "join_room", roomId: room.id });
    const result = await owner.waitFor(
      (e) => e.type === "error" || (e.type === "room_state" && e.roomId === room.id),
    );
    expect(result.type).toBe("room_state");
    owner.close();
  });

  test("the code never appears in a room listing", async () => {
    const { session } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    await lockedRoom(session.code, owner.id, "TOPSECRET");

    const { rooms } = await json<{ rooms: Room[] }>(`/api/sessions/${session.code}/rooms`);
    const serialised = JSON.stringify(rooms);
    expect(serialised).not.toContain("TOPSECRET");
    expect(rooms.find((r) => r.isLocked)).toBeTruthy();
    owner.close();
  });

  test("only the owner can reveal the code", async () => {
    const { session } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    const other = await Participant.join(session.code, "Other");
    const { room } = await lockedRoom(session.code, owner.id, "SHAREME");

    const reveal = (pid: string) =>
      fetch(`${API}/api/rooms/${room.id}/code?participantId=${encodeURIComponent(pid)}`);

    const mine = await reveal(owner.id);
    expect(mine.status).toBe(200);
    expect(((await mine.json()) as { code: string }).code).toBe("SHAREME");
    expect((await reveal(other.id)).status).toBe(403);

    owner.close();
    other.close();
  });

  test("a non-member cannot upload into a locked room", async () => {
    const { session } = await createSession();
    const owner = await Participant.join(session.code, "Owner");
    const outsider = await Participant.join(session.code, "Outsider");
    const { room } = await lockedRoom(session.code, owner.id);

    const response = await fetch(`${API}/api/rooms/${room.id}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId: outsider.id,
        mediaType: "text",
        text: "sneaky",
        strategy: "rulebased",
      }),
    });
    expect(response.status).toBe(403);

    owner.close();
    outsider.close();
  });
});
