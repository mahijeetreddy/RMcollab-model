import type { Server } from "node:http";
import type { ClientEvent, ServerEvent } from "@rmcollab/shared";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { config } from "../config.js";
import {
  getRoom,
  getSessionByCode,
  insertChatMessage,
  listRecentChatMessages,
  listRoomMediaWithJobs,
  listRoomParticipants,
  listRooms,
  setParticipantConnected,
  setParticipantRoom,
  upsertParticipant,
  resolveRoomAccess,
} from "../db/repositories.js";
import { pubsub } from "./pubsub.js";
import { roomRegistry, sessionRegistry } from "./registry.js";

const clientEventSchema: z.ZodType<ClientEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join_session"),
    sessionCode: z.string().trim().min(1).max(32),
    displayName: z.string().trim().min(1).max(64),
    participantId: z.string().trim().min(1).max(64).optional(),
  }),
  z.object({
    type: z.literal("join_room"),
    roomId: z.string().trim().min(1).max(64),
    code: z.string().trim().max(64).optional(),
  }),
  z.object({
    type: z.literal("chat_message"),
    roomId: z.string().trim().min(1).max(64),
    body: z.string().trim().min(1).max(4000),
  }),
  z.object({
    type: z.literal("typing"),
    roomId: z.string().trim().min(1).max(64),
    isTyping: z.boolean(),
  }),
  z.object({ type: z.literal("ping") }),
]);

interface ConnectionState {
  participantId: string | null;
  sessionId: string | null;
  displayName: string | null;
  roomId: string | null;
  alive: boolean;
}

const states = new Map<WebSocket, ConnectionState>();

function send(socket: WebSocket, event: ServerEvent): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(event));
}

function fail(socket: WebSocket, code: string, message: string): void {
  send(socket, { type: "error", code, message });
}

async function leaveRoom(socket: WebSocket, state: ConnectionState): Promise<void> {
  const { roomId, participantId } = state;
  if (!roomId) return;
  state.roomId = null;
  if (roomRegistry.remove(roomId, socket)) {
    await pubsub.unsubscribeRoom(roomId).catch(() => undefined);
  }
  if (participantId) {
    await pubsub.publishToRoom(roomId, { type: "participant_left", roomId, participantId });
  }
}

async function enterRoom(
  socket: WebSocket,
  state: ConnectionState,
  roomId: string,
  code?: string,
): Promise<void> {
  const room = await getRoom(roomId);
  if (!room || room.sessionId !== state.sessionId) {
    fail(socket, "room_not_found", "That room does not exist in this session.");
    return;
  }
  if (!state.participantId) {
    fail(socket, "not_joined", "Join a session first.");
    return;
  }

  // Session membership is not room membership: a locked breakout admits only
  // participants who have presented its code.
  const access = await resolveRoomAccess(roomId, state.participantId, code);
  if (access === "code_required") {
    fail(socket, "room_locked", `"${room.name}" is locked. Enter its room code to join.`);
    return;
  }
  if (access === "code_invalid") {
    fail(socket, "room_code_invalid", `That code does not match "${room.name}".`);
    return;
  }

  if (state.roomId && state.roomId !== roomId) {
    await leaveRoom(socket, state);
  }

  const participant = await setParticipantRoom(state.participantId, roomId);
  if (!participant) {
    fail(socket, "participant_missing", "Your participant record no longer exists.");
    return;
  }

  state.roomId = roomId;
  if (roomRegistry.add(roomId, socket)) {
    await pubsub.subscribeRoom(roomId);
  }

  const [participants, chatHistory, media] = await Promise.all([
    listRoomParticipants(roomId),
    listRecentChatMessages(roomId, config.chatHistoryLimit),
    listRoomMediaWithJobs(roomId),
  ]);

  // Snapshot goes direct so it always precedes the broadcast round-trip.
  send(socket, { type: "room_state", roomId, participants, chatHistory, media });
  await pubsub.publishToRoom(roomId, { type: "participant_joined", roomId, participant });
}

async function handleJoinSession(
  socket: WebSocket,
  state: ConnectionState,
  event: Extract<ClientEvent, { type: "join_session" }>,
): Promise<void> {
  const session = await getSessionByCode(event.sessionCode);
  if (!session) {
    fail(socket, "session_not_found", `No session with code ${event.sessionCode}.`);
    return;
  }

  const participant = await upsertParticipant({
    participantId: event.participantId,
    sessionId: session.id,
    displayName: event.displayName,
  });
  await setParticipantConnected(participant.id, true);

  state.participantId = participant.id;
  state.sessionId = session.id;
  state.displayName = participant.displayName;

  if (sessionRegistry.add(session.id, socket)) {
    await pubsub.subscribeSession(session.id);
  }

  const rooms = await listRooms(session.id);
  send(socket, { type: "session_joined", session, participant, rooms });

  const target = rooms.find((room) => room.isMain) ?? rooms[0];
  if (target) await enterRoom(socket, state, target.id);
}

async function handleTyping(
  state: ConnectionState,
  event: Extract<ClientEvent, { type: "typing" }>,
): Promise<void> {
  // Silently ignored rather than failed: a stale keystroke arriving just after a
  // room switch is not worth an error toast.
  if (!state.participantId || !state.displayName || state.roomId !== event.roomId) return;
  await pubsub.publishToRoom(event.roomId, {
    type: "typing",
    roomId: event.roomId,
    participantId: state.participantId,
    displayName: state.displayName,
    isTyping: event.isTyping,
  });
}

async function handleChatMessage(
  socket: WebSocket,
  state: ConnectionState,
  event: Extract<ClientEvent, { type: "chat_message" }>,
): Promise<void> {
  if (!state.participantId) {
    fail(socket, "not_joined", "Join a session first.");
    return;
  }

  if (state.roomId !== event.roomId) {
    fail(socket, "not_in_room", "You are not in that room.");
    return;
  }
  const message = await insertChatMessage({
    roomId: event.roomId,
    participantId: state.participantId,
    body: event.body,
  });
  if (!message) {
    fail(socket, "chat_failed", "Message could not be stored.");
    return;
  }
  await pubsub.publishToRoom(event.roomId, { type: "chat_message", roomId: event.roomId, message });
}

async function handleEvent(
  socket: WebSocket,
  state: ConnectionState,
  event: ClientEvent,
): Promise<void> {
  switch (event.type) {
    case "join_session":
      return handleJoinSession(socket, state, event);
    case "join_room":
      return enterRoom(socket, state, event.roomId, event.code);
    case "chat_message":
      return handleChatMessage(socket, state, event);
    case "typing":
      return handleTyping(state, event);
    case "ping":
      send(socket, { type: "pong" });
      return;
  }
}

async function handleClose(socket: WebSocket): Promise<void> {
  const state = states.get(socket);
  states.delete(socket);
  if (!state) return;

  if (state.participantId) {
    await setParticipantConnected(state.participantId, false).catch(() => undefined);
  }
  await leaveRoom(socket, state).catch(() => undefined);

  if (state.sessionId && sessionRegistry.remove(state.sessionId, socket)) {
    await pubsub.unsubscribeSession(state.sessionId).catch(() => undefined);
  }
}

export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  pubsub.setHandlers({
    onRoomEvent(roomId, event) {
      const payload = JSON.stringify(event);
      for (const socket of roomRegistry.members(roomId)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      }
    },
    onSessionEvent(sessionId, event) {
      const payload = JSON.stringify(event);
      for (const socket of sessionRegistry.members(sessionId)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      }
    },
  });

  wss.on("connection", (socket) => {
    const state: ConnectionState = {
      participantId: null,
      sessionId: null,
      displayName: null,
      roomId: null,
      alive: true,
    };
    states.set(socket, state);

    socket.on("pong", () => {
      state.alive = true;
    });

    socket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        fail(socket, "bad_json", "Frame was not valid JSON.");
        return;
      }
      const result = clientEventSchema.safeParse(parsed);
      if (!result.success) {
        fail(socket, "bad_event", "Frame did not match any known client event.");
        return;
      }
      handleEvent(socket, state, result.data).catch((err: unknown) => {
        console.error("[ws] handler error", err);
        fail(socket, "internal_error", "The gateway could not process that event.");
      });
    });

    socket.on("error", (err) => console.error("[ws] socket error", err.message));
    socket.on("close", () => {
      handleClose(socket).catch((err: unknown) => console.error("[ws] close error", err));
    });
  });

  const heartbeat = setInterval(() => {
    for (const [socket, state] of states) {
      if (!state.alive) {
        socket.terminate();
        continue;
      }
      state.alive = false;
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();

  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}
