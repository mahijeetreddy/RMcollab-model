import { describe, expect, it } from "vitest";
import { isMetrics, isRoom, isServerEvent } from "../src/lib/guards";

type Frame = Record<string, unknown>;

const session = (o: Frame = {}): Frame => ({ id: "s-1", code: "ABC123", name: null, createdAt: 1, ...o });

const room = (o: Frame = {}): Frame => ({
  id: "r-1",
  sessionId: "s-1",
  name: "Main",
  isMain: true,
  isLocked: false,
  ownerId: null,
  createdAt: 1,
  ...o,
});

const participant = (o: Frame = {}): Frame => ({
  id: "p-1",
  sessionId: "s-1",
  displayName: "Ada",
  currentRoomId: null,
  connected: true,
  joinedAt: 1,
  ...o,
});

const chatMessage = (o: Frame = {}): Frame => ({
  id: "m-1",
  roomId: "r-1",
  participantId: "p-1",
  displayName: "Ada",
  body: "hi",
  createdAt: 1,
  ...o,
});

const mediaItem = (o: Frame = {}): Frame => ({
  id: "mi-1",
  roomId: "r-1",
  uploaderId: "p-1",
  uploaderName: "Ada",
  mediaType: "image",
  originalFilename: null,
  originalUrl: "/f/cat.png",
  mimeType: null,
  sizeBytes: null,
  createdAt: 1,
  ...o,
});

const artifact = (o: Frame = {}): Frame => ({
  id: "a-1",
  jobId: "j-1",
  kind: "transcript",
  label: "Transcript",
  url: "/f/t.json",
  mimeType: "application/json",
  sizeBytes: 12,
  meta: { segments: [] },
  createdAt: 2,
  ...o,
});

const job = (o: Frame = {}): Frame => ({
  id: "j-1",
  mediaItemId: "mi-1",
  mediaType: "image",
  strategy: "upscale",
  status: "queued",
  progress: 0,
  message: null,
  artifacts: [],
  error: null,
  attemptCount: 0,
  createdAt: 1,
  startedAt: null,
  completedAt: null,
  ...o,
});

function without(frame: Frame, key: string): Frame {
  const { [key]: _removed, ...rest } = frame;
  return rest;
}

const valid: Record<string, Frame> = {
  session_joined: { type: "session_joined", session: session(), participant: participant(), rooms: [room()] },
  room_state: {
    type: "room_state",
    roomId: "r-1",
    participants: [participant()],
    chatHistory: [chatMessage()],
    media: [{ mediaItem: mediaItem(), job: job() }, { mediaItem: mediaItem({ id: "mi-2" }), job: null }],
  },
  chat_message: { type: "chat_message", roomId: "r-1", message: chatMessage() },
  typing: { type: "typing", roomId: "r-1", participantId: "p-1", displayName: "Ada", isTyping: true },
  media_uploaded: { type: "media_uploaded", roomId: "r-1", mediaItem: mediaItem(), job: job() },
  job_status_update: {
    type: "job_status_update",
    roomId: "r-1",
    jobId: "j-1",
    mediaItemId: "mi-1",
    status: "processing",
    progress: 0.5,
  },
  job_complete: {
    type: "job_complete",
    roomId: "r-1",
    jobId: "j-1",
    mediaItemId: "mi-1",
    status: "done",
    artifacts: [artifact(), artifact({ id: "a-2", kind: "summary" })],
  },
  rooms_updated: { type: "rooms_updated", sessionId: "s-1", rooms: [room(), room({ id: "r-2", isMain: false, isLocked: true, ownerId: "p-1" })] },
  error: { type: "error", code: "room_locked", message: "Locked" },
};

function event(type: keyof typeof valid, o: Frame = {}): Frame {
  return { ...valid[type], ...o };
}

describe("isServerEvent: well-formed events", () => {
  it.each(Object.keys(valid))("accepts a valid %s", (type) => {
    expect(isServerEvent(valid[type])).toBe(true);
  });

  it("accepts optional fields when present", () => {
    expect(isServerEvent(event("job_status_update", { message: "resizing" }))).toBe(true);
    expect(isServerEvent(event("job_complete", { status: "failed", artifacts: [], error: "boom" }))).toBe(true);
  });
});

describe("isServerEvent: structural failures", () => {
  it.each([
    ["session_joined", "session"],
    ["room_state", "chatHistory"],
    ["chat_message", "message"],
    ["typing", "isTyping"],
    ["media_uploaded", "job"],
    ["job_status_update", "progress"],
    ["job_complete", "mediaItemId"],
    ["rooms_updated", "sessionId"],
    ["error", "message"],
  ] as const)("rejects %s missing %s", (type, key) => {
    expect(isServerEvent(without(valid[type]!, key))).toBe(false);
  });

  it("rejects wrong primitive types", () => {
    expect(isServerEvent(event("typing", { isTyping: "true" }))).toBe(false);
    expect(isServerEvent(event("job_status_update", { progress: "0.5" }))).toBe(false);
    expect(isServerEvent(event("job_status_update", { progress: Number.NaN }))).toBe(false);
    expect(isServerEvent(event("error", { code: 500 }))).toBe(false);
    expect(isServerEvent(event("chat_message", { message: chatMessage({ createdAt: "now" }) }))).toBe(false);
    expect(isServerEvent(event("job_status_update", { message: null }))).toBe(false);
  });

  it("rejects a malformed element nested inside an array", () => {
    expect(isServerEvent(event("room_state", { participants: [participant(), { id: "p-2" }] }))).toBe(false);
    expect(isServerEvent(event("room_state", { media: [{ mediaItem: mediaItem(), job: job({ status: "stuck" }) }] }))).toBe(false);
  });

  it("rejects an unknown event type, a missing type, and non-object frames", () => {
    expect(isServerEvent({ type: "room_teleported", roomId: "r-1" })).toBe(false);
    expect(isServerEvent(without(valid.error!, "type"))).toBe(false);
    expect(isServerEvent(null)).toBe(false);
    expect(isServerEvent([valid.error])).toBe(false);
    expect(isServerEvent(JSON.stringify(valid.error))).toBe(false);
  });

  // `type in eventGuards` also sees Object.prototype, so these names must not reach a "guard".
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "__proto__"])(
    "rejects the inherited property name %j as an event type",
    (type) => {
      expect(isServerEvent({ type })).toBe(false);
    },
  );
});

describe("isServerEvent: narrowed job status literals", () => {
  it.each(["queued", "processing"])("job_status_update accepts %s", (status) => {
    expect(isServerEvent(event("job_status_update", { status }))).toBe(true);
  });

  it.each(["done", "failed", "PROCESSING", ""])("job_status_update rejects %j", (status) => {
    expect(isServerEvent(event("job_status_update", { status }))).toBe(false);
  });

  it.each(["done", "failed"])("job_complete accepts %s", (status) => {
    expect(isServerEvent(event("job_complete", { status }))).toBe(true);
  });

  it("job_complete accepts an optional closing message, but only a string", () => {
    expect(isServerEvent(event("job_complete", { message: "done in 3s" }))).toBe(true);
    expect(isServerEvent(event("job_complete", { message: 3 }))).toBe(false);
  });

  it.each(["queued", "processing"])("job_complete rejects %s", (status) => {
    expect(isServerEvent(event("job_complete", { status }))).toBe(false);
  });
});

describe("isServerEvent: job_complete artifacts", () => {
  it("requires an artifacts array", () => {
    expect(isServerEvent(without(valid.job_complete!, "artifacts"))).toBe(false);
    expect(isServerEvent(event("job_complete", { artifacts: artifact() }))).toBe(false);
  });

  it("rejects an artifact with an unknown kind", () => {
    expect(isServerEvent(event("job_complete", { artifacts: [artifact({ kind: "thumbnail" })] }))).toBe(false);
  });

  it("rejects an artifact whose meta is not a record", () => {
    for (const meta of [null, [], "x", undefined]) {
      expect(isServerEvent(event("job_complete", { artifacts: [artifact({ meta })] }))).toBe(false);
    }
  });

  it("rejects an artifact without a url", () => {
    expect(isServerEvent(event("job_complete", { artifacts: [without(artifact(), "url")] }))).toBe(false);
  });
});

describe("isRoom", () => {
  it("accepts a room with a null or string owner", () => {
    expect(isRoom(room())).toBe(true);
    expect(isRoom(room({ ownerId: "p-1", isLocked: true }))).toBe(true);
  });

  // The gateway never sends a room's access code, only isLocked; a room without it cannot be gated.
  it("rejects a room missing isLocked or ownerId", () => {
    expect(isRoom(without(room(), "isLocked"))).toBe(false);
    expect(isRoom(without(room(), "ownerId"))).toBe(false);
  });

  it("rejects wrongly typed isLocked or ownerId", () => {
    expect(isRoom(room({ isLocked: "false" }))).toBe(false);
    expect(isRoom(room({ ownerId: 42 }))).toBe(false);
  });

  it("makes session_joined and rooms_updated reject a pre-lock room shape", () => {
    const legacy = without(without(room(), "isLocked"), "ownerId");
    expect(isServerEvent(event("session_joined", { rooms: [legacy] }))).toBe(false);
    expect(isServerEvent(event("rooms_updated", { rooms: [room(), legacy] }))).toBe(false);
  });
});

describe("isMetrics", () => {
  const metrics = (o: Frame = {}): Frame => ({
    replicaId: "gw-1",
    queues: [
      { mediaType: "image", queue: "enhance.image", depth: 3, workersOnline: true },
      { mediaType: "audio", queue: "enhance.audio", depth: 0, workersOnline: false },
    ],
    jobs: { queued: 3, done: 10 },
    jobEventStreamLength: 42,
    at: 1,
    ...o,
  });

  it("accepts a valid metrics payload", () => {
    expect(isMetrics(metrics())).toBe(true);
    expect(isMetrics(metrics({ queues: [] }))).toBe(true);
  });

  it("rejects a malformed queue entry", () => {
    expect(isMetrics(metrics({ queues: [{ mediaType: "image", queue: "enhance.image", depth: "3", workersOnline: true }] }))).toBe(false);
    expect(isMetrics(metrics({ queues: [{ mediaType: "image", queue: "enhance.image", depth: 3 }] }))).toBe(false);
    expect(isMetrics(metrics({ queues: [null] }))).toBe(false);
  });

  it("rejects missing top-level fields", () => {
    expect(isMetrics(without(metrics(), "replicaId"))).toBe(false);
    expect(isMetrics(without(metrics(), "jobs"))).toBe(false);
    expect(isMetrics(metrics({ jobEventStreamLength: null }))).toBe(false);
  });
});
