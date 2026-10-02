import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Artifact,
  ChatMessage,
  EnhancementJob,
  MediaItem,
  MediaItemWithJob,
  Participant,
  Room,
  ServerEvent,
} from "@rmcollab/shared";
import { initialRoomState, roomReducer, type RoomState } from "../src/state/roomReducer";

const ROOM = "room-a";
const OTHER_ROOM = "room-b";
const NOW = 1_700_000_000_000;

function participant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: "p-1",
    sessionId: "s-1",
    displayName: "Ada",
    currentRoomId: ROOM,
    connected: true,
    joinedAt: 1,
    ...overrides,
  };
}

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "m-1",
    roomId: ROOM,
    participantId: "p-2",
    displayName: "Grace",
    body: "hello",
    createdAt: 10,
    ...overrides,
  };
}

function mediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "mi-1",
    roomId: ROOM,
    uploaderId: "p-2",
    uploaderName: "Grace",
    mediaType: "image",
    originalFilename: "cat.png",
    title: null,
    originalUrl: "/files/cat.png",
    mimeType: "image/png",
    sizeBytes: 1024,
    createdAt: 100,
    ...overrides,
  };
}

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: "a-1",
    jobId: "job-1",
    kind: "enhanced",
    label: "Enhanced",
    url: "/files/cat.enhanced.png",
    mimeType: "image/png",
    sizeBytes: 2048,
    meta: {},
    createdAt: 200,
    ...overrides,
  };
}

function job(overrides: Partial<EnhancementJob> = {}): EnhancementJob {
  return {
    id: "job-1",
    mediaItemId: "mi-1",
    mediaType: "image",
    strategy: "upscale",
    status: "queued",
    progress: 0,
    message: null,
    artifacts: [],
    error: null,
    attemptCount: 1,
    createdAt: 100,
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

function entry(item: Partial<MediaItem> = {}, j: Partial<EnhancementJob> | null = {}): MediaItemWithJob {
  const mi = mediaItem(item);
  return { mediaItem: mi, job: j === null ? null : job({ mediaItemId: mi.id, ...j }) };
}

function room(overrides: Partial<Room> = {}): Room {
  return {
    id: ROOM,
    sessionId: "s-1",
    name: "Main",
    isMain: true,
    isLocked: false,
    ownerId: null,
    createdAt: 1,
    ...overrides,
  };
}

/** A state that is synced into ROOM as participant `me`. */
function syncedState(overrides: Partial<RoomState> = {}): RoomState {
  return {
    ...initialRoomState,
    me: participant({ id: "me" }),
    activeRoomId: ROOM,
    synced: true,
    ...overrides,
  };
}

function apply(state: RoomState, event: ServerEvent): RoomState {
  return roomReducer(state, { type: "server_event", event });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("room_state", () => {
  it("replaces room-scoped data wholesale and marks the room synced", () => {
    const before = syncedState({
      activeRoomId: OTHER_ROOM,
      synced: false,
      participants: [participant({ id: "stale" })],
      chat: [message({ id: "stale-msg" })],
      media: [entry({ id: "stale-media" })],
    });

    const next = apply(before, {
      type: "room_state",
      roomId: ROOM,
      participants: [participant({ id: "p-9" })],
      chatHistory: [message({ id: "m-2", createdAt: 20 }), message({ id: "m-1", createdAt: 10 })],
      media: [entry({ id: "old", createdAt: 1 }), entry({ id: "new", createdAt: 5 })],
    });

    expect(next.activeRoomId).toBe(ROOM);
    expect(next.synced).toBe(true);
    expect(next.participants.map((p) => p.id)).toEqual(["p-9"]);
    expect(next.chat.map((m) => m.id)).toEqual(["m-1", "m-2"]);
    expect(next.media.map((m) => m.mediaItem.id)).toEqual(["new", "old"]);
  });

  it("clears lastError so a refused locked-room prompt does not outlive a successful retry", () => {
    const refused = apply(syncedState({ synced: false }), {
      type: "error",
      code: "room_code_required",
      message: "This room is locked",
    });
    expect(refused.lastError).not.toBeNull();

    const entered = apply(refused, {
      type: "room_state",
      roomId: ROOM,
      participants: [],
      chatHistory: [],
      media: [],
    });
    expect(entered.lastError).toBeNull();
  });
});

describe("chat_message", () => {
  it("appends a new message", () => {
    const next = apply(syncedState(), { type: "chat_message", roomId: ROOM, message: message() });
    expect(next.chat.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("is de-duplicated by message id", () => {
    const state = syncedState({ chat: [message({ id: "m-1" })] });
    const next = apply(state, {
      type: "chat_message",
      roomId: ROOM,
      message: message({ id: "m-1", body: "replayed" }),
    });
    expect(next).toBe(state);
  });

  it("is ignored for a room that is not the active one", () => {
    const state = syncedState();
    const next = apply(state, { type: "chat_message", roomId: OTHER_ROOM, message: message() });
    expect(next).toBe(state);
  });

  it("is held while the active room has not synced yet, then shown on top of its snapshot", () => {
    const state = syncedState({ synced: false });
    const held = apply(state, { type: "chat_message", roomId: ROOM, message: message({ id: "late" }) });
    expect(held.chat).toEqual([]);
    const synced = apply(held, { type: "room_state", roomId: ROOM, participants: [], chatHistory: [], media: [] });
    expect(synced.chat.map((m) => m.id)).toEqual(["late"]);
    expect(synced.heldEvents).toEqual([]);
  });

  it("removes the sender's typing indicator but keeps everyone else's", () => {
    const state = syncedState({
      typing: {
        "p-2": { displayName: "Grace", at: NOW },
        "p-3": { displayName: "Linus", at: NOW },
      },
    });
    const next = apply(state, {
      type: "chat_message",
      roomId: ROOM,
      message: message({ participantId: "p-2" }),
    });
    expect(Object.keys(next.typing)).toEqual(["p-3"]);
  });
});

describe("typing", () => {
  const typing = (overrides: Partial<Extract<ServerEvent, { type: "typing" }>> = {}): ServerEvent => ({
    type: "typing",
    roomId: ROOM,
    participantId: "p-2",
    displayName: "Grace",
    isTyping: true,
    ...overrides,
  });

  it("adds an entry stamped with the arrival time when isTyping is true", () => {
    const next = apply(syncedState(), typing());
    expect(next.typing).toEqual({ "p-2": { displayName: "Grace", at: NOW } });
  });

  it("removes the entry when isTyping is false", () => {
    const state = syncedState({ typing: { "p-2": { displayName: "Grace", at: NOW } } });
    const next = apply(state, typing({ isTyping: false }));
    expect(next.typing).toEqual({});
  });

  it("returns the same state for a stop from someone not marked as typing", () => {
    const state = syncedState();
    expect(apply(state, typing({ isTyping: false }))).toBe(state);
  });

  it("ignores the local participant's own events", () => {
    const state = syncedState();
    expect(apply(state, typing({ participantId: "me" }))).toBe(state);
  });

  it("ignores events for another room", () => {
    const state = syncedState();
    expect(apply(state, typing({ roomId: OTHER_ROOM }))).toBe(state);
  });
});

describe("prune_typing", () => {
  it("drops only entries older than the cutoff", () => {
    const state = syncedState({
      typing: {
        stale: { displayName: "Old", at: 100 },
        edge: { displayName: "Edge", at: 200 },
        fresh: { displayName: "New", at: 300 },
      },
    });
    const next = roomReducer(state, { type: "prune_typing", olderThan: 200 });
    expect(Object.keys(next.typing).sort()).toEqual(["edge", "fresh"]);
  });

  // Dispatched on an interval: a fresh object every tick would re-render the room for nothing.
  it("returns the same state object when nothing is pruned", () => {
    const state = syncedState({ typing: { fresh: { displayName: "New", at: 300 } } });
    expect(roomReducer(state, { type: "prune_typing", olderThan: 200 })).toBe(state);
    const empty = syncedState();
    expect(roomReducer(empty, { type: "prune_typing", olderThan: 200 })).toBe(empty);
  });
});

describe("connection_lost", () => {
  it("clears typing indicators and marks the room unsynced", () => {
    const state = syncedState({ typing: { "p-2": { displayName: "Grace", at: NOW } } });
    const next = roomReducer(state, { type: "connection_lost" });
    expect(next.synced).toBe(false);
    expect(next.typing).toEqual({});
    expect(next.activeRoomId).toBe(ROOM);
  });

  it("is a no-op when already unsynced with no typing", () => {
    const state = syncedState({ synced: false });
    expect(roomReducer(state, { type: "connection_lost" })).toBe(state);
  });

  it("holds incremental events until the next snapshot arrives, and keeps the room's contents meanwhile", () => {
    const lost = roomReducer(syncedState({ chat: [message({ id: "before" })] }), { type: "connection_lost" });
    const held = apply(lost, { type: "chat_message", roomId: ROOM, message: message({ id: "during" }) });
    expect(held.chat.map((m) => m.id)).toEqual(["before"]);
    // Asking for the same room again does not empty it while the snapshot is on its way.
    expect(roomReducer(held, { type: "room_requested", roomId: ROOM }).chat.map((m) => m.id)).toEqual(["before"]);
  });
});

describe("job_status_update", () => {
  const update = (
    overrides: Partial<Extract<ServerEvent, { type: "job_status_update" }>> = {},
  ): ServerEvent => ({
    type: "job_status_update",
    roomId: ROOM,
    jobId: "job-1",
    mediaItemId: "mi-1",
    status: "processing",
    progress: 0.4,
    ...overrides,
  });

  it("patches the job of the media item matched by mediaItemId, adopting a retry's new job id", () => {
    const state = syncedState({ media: [entry({ id: "mi-1" }, { id: "job-1" }), entry({ id: "mi-2" }, { id: "job-2" })] });
    const next = apply(state, update({ jobId: "job-1-retry", mediaItemId: "mi-1" }));

    const [first, second] = next.media;
    expect(first?.job).toMatchObject({ id: "job-1-retry", status: "processing", progress: 0.4, startedAt: NOW });
    expect(second).toBe(state.media[1]);
  });

  it("does not match on job id", () => {
    const state = syncedState({ media: [entry({ id: "mi-1" }, { id: "job-1" })] });
    const next = apply(state, update({ jobId: "job-1", mediaItemId: "mi-unknown" }));
    expect(next.media).toBe(state.media);
  });

  it("clamps progress into [0, 1] and keeps the previous message when none is sent", () => {
    const state = syncedState({ media: [entry({}, { message: "warming up" })] });
    const next = apply(state, update({ progress: 7 }));
    expect(next.media[0]?.job).toMatchObject({ progress: 1, message: "warming up" });
  });

  it("leaves a media item without a job untouched", () => {
    const state = syncedState({ media: [entry({}, null)] });
    expect(apply(state, update()).media).toBe(state.media);
  });
});

describe("job_complete", () => {
  const complete = (
    overrides: Partial<Extract<ServerEvent, { type: "job_complete" }>> = {},
  ): ServerEvent => ({
    type: "job_complete",
    roomId: ROOM,
    jobId: "job-1",
    mediaItemId: "mi-1",
    status: "done",
    artifacts: [],
    ...overrides,
  });

  it("replaces artifacts when the event carries some, matched by mediaItemId", () => {
    const fresh = artifact({ id: "a-new", jobId: "job-2" });
    const state = syncedState({
      media: [entry({ id: "mi-1" }, { id: "job-1", artifacts: [artifact({ id: "a-old" })] })],
    });
    const next = apply(state, complete({ jobId: "job-2", artifacts: [fresh] }));
    expect(next.media[0]?.job).toMatchObject({
      id: "job-2",
      status: "done",
      progress: 1,
      artifacts: [fresh],
      completedAt: NOW,
    });
  });

  it("keeps existing artifacts when the event's artifacts array is empty", () => {
    const existing = [artifact({ id: "a-old" })];
    const state = syncedState({ media: [entry({}, { artifacts: existing })] });
    const next = apply(state, complete({ status: "failed", error: "boom" }));
    expect(next.media[0]?.job?.artifacts).toBe(existing);
    expect(next.media[0]?.job).toMatchObject({ status: "failed", error: "boom" });
  });

  it("replaces the last progress message with the closing one", () => {
    // Regression: the card kept showing "summarising" after the job finished.
    const state = syncedState({ media: [entry({}, { message: "summarising" })] });
    const next = apply(state, complete({ message: "produced transcript and summary in 3s" }));
    expect(next.media[0]?.job?.message).toBe("produced transcript and summary in 3s");
  });

  it("keeps the last progress message when the completion carries none", () => {
    const state = syncedState({ media: [entry({}, { message: "summarising" })] });
    expect(apply(state, complete()).media[0]?.job?.message).toBe("summarising");
  });

  it("ignores a completion for another room", () => {
    const state = syncedState({ media: [entry()] });
    expect(apply(state, complete({ roomId: OTHER_ROOM }))).toBe(state);
  });
});

describe("room_requested", () => {
  it("resets room-scoped state and marks the room unsynced", () => {
    const rooms = [room()];
    const state = syncedState({
      rooms,
      participants: [participant()],
      chat: [message()],
      media: [entry()],
      typing: { "p-2": { displayName: "Grace", at: NOW } },
    });
    const next = roomReducer(state, { type: "room_requested", roomId: OTHER_ROOM });
    expect(next).toMatchObject({
      activeRoomId: OTHER_ROOM,
      synced: false,
      participants: [],
      chat: [],
      media: [],
      typing: {},
    });
    expect(next.rooms).toBe(rooms);
    expect(next.me).toBe(state.me);
  });

  it("is a no-op when re-requesting the room already synced", () => {
    const state = syncedState({ chat: [message()] });
    expect(roomReducer(state, { type: "room_requested", roomId: ROOM })).toBe(state);
  });
});

describe("error", () => {
  it("sets lastError with the code, message and time", () => {
    const next = apply(syncedState(), { type: "error", code: "room_locked", message: "Wrong code" });
    expect(next.lastError).toEqual({ code: "room_locked", message: "Wrong code", at: NOW });
  });

  it("is cleared by clear_error", () => {
    const errored = apply(syncedState(), { type: "error", code: "x", message: "y" });
    expect(roomReducer(errored, { type: "clear_error" }).lastError).toBeNull();
  });
});

describe("waiting room", () => {
  const session = { id: "s-1", code: "ABCDE23456", name: "Biology", createdAt: 1, waitingRoom: true, kept: false, retentionDays: 3 };

  it("holds a newcomer on the waiting screen until they are let in", () => {
    let state = apply(initialRoomState, { type: "admission_waiting", sessionName: "Biology", ownerName: "Ada" });
    expect(state.admission).toEqual({ status: "waiting", sessionName: "Biology", ownerName: "Ada", ownerOnline: true });
    // Being let in is followed by the ordinary session_joined, which clears it.
    state = apply(state, { type: "admission_decided", sessionId: "s-1", participantId: "p-9", admitted: true, byName: "Ada" });
    expect(state.admission?.status).toBe("waiting");
    state = apply(state, { type: "session_joined", session, participant: participant(), rooms: [] });
    expect(state.admission).toBeNull();
  });

  it("tells a newcomer who was turned away", () => {
    let state = apply(initialRoomState, { type: "admission_waiting", sessionName: null, ownerName: null });
    state = apply(state, { type: "admission_decided", sessionId: "s-1", participantId: "p-9", admitted: false, byName: "Ada" });
    expect(state.admission).toEqual({ status: "denied", byName: "Ada" });
  });

  it("lists requests for the owner once each, and drops answered ones", () => {
    const request = { type: "admission_requested" as const, sessionId: "s-1", participant: { id: "p-9", displayName: "Bo" } };
    let state = apply(initialRoomState, request);
    state = apply(state, request);
    expect(state.waitingList).toEqual([{ id: "p-9", displayName: "Bo" }]);
    state = apply(state, { type: "admission_decided", sessionId: "s-1", participantId: "p-9", admitted: true, byName: "Ada" });
    expect(state.waitingList).toEqual([]);
    expect(state.admissionDecided).toEqual(["p-9"]);
    expect(state.admission).toBeNull();
  });

  it("drops a request from the owner's list when its sender gives up waiting", () => {
    let state = apply(initialRoomState, { type: "admission_requested", sessionId: "s-1", participant: { id: "p-9", displayName: "Bo" } });
    state = apply(state, { type: "admission_withdrawn", sessionId: "s-1", participantId: "p-9" });
    expect(state.waitingList).toEqual([]);
    expect(state.admissionDecided).toContain("p-9");
  });

  it("takes a changed code from session_updated", () => {
    const state = apply(initialRoomState, { type: "session_updated", session: { ...session, code: "ZZZZZ22222" } });
    expect(state.session?.code).toBe("ZZZZZ22222");
  });
});

describe("loadedRoomId", () => {
  const snapshot = (roomId: string) =>
    apply(initialRoomState, { type: "room_state", roomId, participants: [], chatHistory: [], media: [] });

  it("is set by a room's snapshot", () => {
    expect(snapshot(ROOM).loadedRoomId).toBe(ROOM);
  });

  it("survives a dropped connection and the rejoin of the same room", () => {
    let state = roomReducer(snapshot(ROOM), { type: "connection_lost" });
    expect(state.synced).toBe(false);
    expect(state.loadedRoomId).toBe(ROOM);
    state = roomReducer(state, { type: "room_requested", roomId: ROOM });
    expect(state.loadedRoomId).toBe(ROOM);
  });

  it("goes when another room is chosen", () => {
    expect(roomReducer(snapshot(ROOM), { type: "room_requested", roomId: OTHER_ROOM }).loadedRoomId).toBeNull();
  });
});

describe("events that arrive between asking for a room and its snapshot", () => {
  const snapshot = (participants: Participant[] = []): ServerEvent => ({
    type: "room_state",
    roomId: ROOM,
    participants,
    chatHistory: [],
    media: [],
  });

  it("keeps someone who joined in that moment (everyone moved out of a deleted room at once)", () => {
    let state = roomReducer(syncedState({ activeRoomId: OTHER_ROOM }), { type: "room_requested", roomId: ROOM });
    state = apply(state, { type: "participant_joined", roomId: ROOM, participant: participant({ id: "bob", displayName: "Bob" }) });
    // The snapshot was taken just before Bob arrived.
    state = apply(state, snapshot([participant({ id: "me", displayName: "Alice" })]));
    expect(state.participants.map((p) => p.displayName).sort()).toEqual(["Alice", "Bob"]);
  });

  it("drops what was held for a room left before its snapshot came", () => {
    let state = roomReducer(syncedState({ activeRoomId: OTHER_ROOM }), { type: "room_requested", roomId: ROOM });
    state = apply(state, { type: "participant_joined", roomId: ROOM, participant: participant({ id: "bob" }) });
    state = roomReducer(state, { type: "room_requested", roomId: OTHER_ROOM });
    expect(state.heldEvents).toEqual([]);
  });

  it("never moves a job backwards: a finished job ignores an older progress update", () => {
    let state = roomReducer(syncedState({ activeRoomId: OTHER_ROOM }), { type: "room_requested", roomId: ROOM });
    state = apply(state, {
      type: "job_status_update",
      roomId: ROOM,
      jobId: "job-1",
      mediaItemId: "mi-1",
      status: "processing",
      progress: 0.5,
    });
    // By the time the snapshot was read, the job had finished.
    state = apply(state, {
      type: "room_state",
      roomId: ROOM,
      participants: [],
      chatHistory: [],
      media: [entry({ id: "mi-1" }, { id: "job-1", status: "done", progress: 1 })],
    });
    expect(state.media[0]!.job!.status).toBe("done");
    expect(state.media[0]!.job!.progress).toBe(1);
  });
});
