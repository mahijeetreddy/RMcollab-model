import type { Server } from "node:http";
import type { ClientEvent, ServerEvent } from "@rmcollab/shared";
import { nanoid } from "nanoid";
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
  claimMainRoom,
  getParticipant,
  getSessionById,
  isAdmittedMember,
  isWaiting,
  sessionOwnerId,
  setWaiting,
} from "../db/repositories.js";
import { answerQuestion } from "../ask/service.js";
import { docKey, isDocId, MAIN_DOC_ID } from "@rmcollab/shared/notes";
import { getDocument } from "../db/roomDocs.js";
import { docHub } from "../docs/hub.js";
import { touch } from "../lifecycle.js";
import { codeGuessesBlocked, recordCodeMiss } from "../limits.js";
import { pubsub } from "./pubsub.js";
import { gone, here } from "./presence.js";
import { socketLimits, type SocketLimits } from "./rateLimit.js";
import { roomRegistry, sessionRegistry } from "./registry.js";

const clientEventSchema: z.ZodType<ClientEvent> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("join_session"),
    sessionCode: z.string().trim().min(1).max(32),
    displayName: z.string().trim().min(1).max(64),
    participantId: z.string().trim().min(1).max(64).optional(),
    roomId: z.string().trim().min(1).max(64).optional(),
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
  z.object({
    type: z.literal("doc"),
    roomId: z.string().trim().min(1).max(64),
    // A single edit is small; the cap bounds a full-document sync of a large
    // room, and stops one frame from ballooning a replica's memory.
    data: z.string().min(1).max(4_000_000),
    docId: z.string().trim().min(1).max(40).optional(),
  }),
  z.object({
    type: z.literal("ask"),
    roomId: z.string().trim().min(1).max(64),
    requestId: z.string().trim().min(8).max(64),
    question: z.string().trim().min(2).max(500),
    // The asker's own earlier turns, held by their browser: the gateway keeps no
    // conversation, so a follow-up brings its context with it.
    history: z
      .array(z.object({ question: z.string().max(500), answer: z.string().max(2000) }))
      .max(3)
      .optional(),
  }),
  z.object({ type: z.literal("ping") }),
]);

interface ConnectionState {
  /** Unique per socket: how the doc hub avoids echoing an edit to its author. */
  connId: string;
  participantId: string | null;
  sessionId: string | null;
  displayName: string | null;
  roomId: string | null;
  alive: boolean;
  /** The client's address, through the load balancer: for per-address limits. */
  address: string;
  /** Documents of the current room this socket has been checked into. */
  docs: Set<string>;
  /** In the waiting room: connected, but shown nothing of the session. */
  pending: boolean;
  /** The room asked for on joining (a reconnect), entered once the join completes. */
  preferredRoomId: string | null;
  /**
   * Frames are handled one at a time, in the order they came. Handled
   * concurrently, a reconnect's join_session and the join_room right behind it
   * raced: the room join ran before the session join had finished, failed, and
   * the person landed back in the main room.
   */
  queue: Promise<void>;
  /** What this connection may still send; see rateLimit.ts. */
  limits: SocketLimits;
  /**
   * Removed or turned away, and being closed. Its frames are ignored from here;
   * the state itself stays until the close event, whose cleanup (leave the
   * room, mark disconnected, unregister) needs it.
   */
  closing: boolean;
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
  docHub.leaveAll(roomId, state.connId);
  state.docs.clear();
  if (roomRegistry.remove(roomId, socket)) {
    await pubsub.unsubscribeRoom(roomId).catch(() => undefined);
    // No longer receiving the room's traffic, so the replica's copy of its
    // notes would go stale; the hub saves it and lets it go.
    await docHub.dropAll(roomId).catch((err: unknown) => console.error("[docs] drop failed", err));
  }
  if (participantId && (await gone(`room:${roomId}`, participantId, state.connId)) === 0) {
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
  if (access === "banned") {
    fail(socket, "room_banned", `You were removed from "${room.name}" by its owner.`);
    return;
  }
  if (access === "not_member") {
    fail(socket, "not_joined", "You are no longer in this session.");
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
  await here(`room:${roomId}`, state.participantId, state.connId);
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
  const blocked = await codeGuessesBlocked(state.address);
  if (blocked) {
    fail(socket, blocked.error, blocked.message);
    return;
  }
  const session = await getSessionByCode(event.sessionCode, event.participantId);
  if (!session) {
    await recordCodeMiss(state.address);
    fail(socket, "session_not_found", `No session with code ${event.sessionCode}.`);
    return;
  }

  // Someone new, with the waiting room on: they wait, seeing nothing of the
  // session, until its owner lets them in. Current members come straight back.
  const member = await isAdmittedMember(session.id, event.participantId);
  const participant = await upsertParticipant({
    participantId: event.participantId,
    sessionId: session.id,
    displayName: event.displayName,
  });
  await setParticipantConnected(participant.id, true);

  state.participantId = participant.id;
  state.sessionId = session.id;
  state.displayName = participant.displayName;
  state.preferredRoomId = event.roomId ?? null;
  await here(`session:${session.id}`, participant.id, state.connId);
  // The first person into a session owns its main room (and can remove people from it).
  await claimMainRoom(session.id, participant.id);

  if (sessionRegistry.add(session.id, socket)) {
    await pubsub.subscribeSession(session.id);
  }

  const ownerId = await sessionOwnerId(session.id);
  const mustWait = session.waitingRoom && participant.id !== ownerId && (!member || (await isWaiting(participant.id)));
  if (mustWait) {
    state.pending = true;
    await setWaiting(participant.id, true);
    const owner = ownerId ? await getParticipant(ownerId) : null;
    send(socket, {
      type: "admission_waiting",
      sessionName: session.name,
      ownerName: owner?.displayName ?? null,
      ownerOnline: Boolean(owner?.connected),
    });
    await pubsub.publishToSession(session.id, {
      type: "admission_requested",
      sessionId: session.id,
      participant: { id: participant.id, displayName: participant.displayName },
    });
    return;
  }
  await completeJoin(socket, state, session.id);
}

/** Into the session: its rooms, then its main room. Also where the waiting room lets someone through. */
async function completeJoin(socket: WebSocket, state: ConnectionState, sessionId: string): Promise<void> {
  state.pending = false;
  const session = await getSessionById(sessionId);
  const participant = state.participantId ? await getParticipant(state.participantId) : null;
  if (!session || !participant) return;
  const rooms = await listRooms(session.id);
  send(socket, { type: "session_joined", session, participant, rooms });

  // Back into the room they were in, when it still exists and they may enter
  // it without a code; otherwise the main room.
  const preferred = rooms.find((room) => room.id === state.preferredRoomId);
  state.preferredRoomId = null;
  const mayEnter =
    preferred &&
    ["open", "granted"].includes(await resolveRoomAccess(preferred.id, participant.id, undefined));
  const target = (mayEnter ? preferred : null) ?? rooms.find((room) => room.isMain) ?? rooms[0];
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

/**
 * Whether this frame is within the connection's limits. Chat and room switches
 * are refused with a reason; typing is dropped, as nobody needs to know. Notes
 * frames close the connection instead: dropping one would leave that editor's
 * copy and everyone else's apart, while a reconnect resyncs the whole document.
 */
function withinLimits(socket: WebSocket, state: ConnectionState, event: ClientEvent): boolean {
  const { limits } = state;
  switch (event.type) {
    case "chat_message":
      if (limits.chat.take()) return true;
      fail(socket, "rate_limited", "You're sending messages very fast. Wait a moment.");
      return false;
    case "typing":
      return limits.typing.take();
    case "join_room":
      if (limits.joins.take()) return true;
      fail(socket, "rate_limited", "Too many room switches at once. Wait a moment.");
      return false;
    case "doc":
      if (limits.docFrames.take() && limits.docBytes.take(event.data.length)) return true;
      state.closing = true;
      socket.close(4008, "too much notes traffic");
      return false;
    default:
      return true;
  }
}

async function handleEvent(
  socket: WebSocket,
  state: ConnectionState,
  event: ClientEvent,
): Promise<void> {
  if (state.closing) return;
  // One session per connection: a second join would leave the first one's
  // registrations behind. A different session is a different connection.
  if (event.type === "join_session" && state.sessionId) {
    fail(socket, "already_joined", "This connection has already joined a session.");
    return;
  }
  // Waiting to be let in: nothing of the session until then.
  if (state.pending && event.type !== "ping" && event.type !== "join_session") {
    fail(socket, "waiting_for_admission", "You are waiting to be let in.");
    return;
  }
  if (!withinLimits(socket, state, event)) return;
  // Anything a person does keeps their session from expiring.
  if (event.type !== "ping") touch(state.sessionId);
  switch (event.type) {
    case "join_session":
      return handleJoinSession(socket, state, event);
    case "join_room":
      return enterRoom(socket, state, event.roomId, event.code);
    case "chat_message":
      return handleChatMessage(socket, state, event);
    case "typing":
      return handleTyping(state, event);
    case "doc": {
      // Only for the room this socket was admitted to - the same check that
      // guards chat and uploads guards the notes. A stale frame from just
      // before a room switch is dropped, not an error.
      if (state.roomId !== event.roomId) return;
      const docId = event.docId ?? MAIN_DOC_ID;
      // Only documents that exist in this room: a made-up id must not become
      // a document. Checked once per connection and room, then remembered.
      if (docId !== MAIN_DOC_ID && !state.docs.has(docId)) {
        if (!isDocId(docId) || !(await getDocument(event.roomId, docId))) return;
        state.docs.add(docId);
      }
      return docHub.receive(docKey(event.roomId, docId), {
        id: state.connId,
        send: (data) => send(socket, { type: "doc", roomId: event.roomId, docId, data }),
      }, event.data);
    }
    case "ask":
      // The room this socket was admitted to, like the notes: a locked room's
      // material is only asked about by people let into it.
      if (state.roomId !== event.roomId || !state.participantId) {
        fail(socket, "not_in_room", "Join the room before asking about it.");
        return;
      }
      // Not awaited: an answer streams for seconds, and this socket's other
      // traffic (typing, notes) must not queue behind it.
      void answerQuestion({
        roomId: event.roomId,
        participantId: state.participantId,
        requestId: event.requestId,
        question: event.question,
        history: event.history ?? [],
        send: (reply) => send(socket, reply),
      }).catch((err: unknown) => {
        console.error("[ask] failed", err);
        send(socket, { type: "ask_done", requestId: event.requestId, cited: [], fallback: "failed" });
      });
      return;
    case "ping":
      send(socket, { type: "pong" });
      return;
  }
}

async function handleClose(socket: WebSocket): Promise<void> {
  const state = states.get(socket);
  states.delete(socket);
  if (!state) return;

  // Disconnected only if this was their last connection: a second tab or
  // device keeps them here.
  if (state.participantId) {
    const others = state.sessionId ? await gone(`session:${state.sessionId}`, state.participantId, state.connId) : 0;
    if (others === 0) await setParticipantConnected(state.participantId, false).catch(() => undefined);
  }
  // Gave up waiting: off the owner's list. Still marked as waiting, so coming
  // back asks again rather than walking in.
  if (state.pending && state.sessionId && state.participantId) {
    const stillHere = [...states.values()].some((s) => s.pending && s.participantId === state.participantId);
    if (!stillHere) {
      await pubsub
        .publishToSession(state.sessionId, {
          type: "admission_withdrawn",
          sessionId: state.sessionId,
          participantId: state.participantId,
        })
        .catch(() => undefined);
    }
  }
  await leaveRoom(socket, state).catch(() => undefined);

  if (state.sessionId && sessionRegistry.remove(state.sessionId, socket)) {
    await pubsub.unsubscribeSession(state.sessionId).catch(() => undefined);
  }
}

export function createWebSocketServer(httpServer: Server): WebSocketServer {
  const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  /** Every local connection of a removed participant: told, then taken out. */
  const removeLocally = (event: Extract<ServerEvent, { type: "participant_removed" }>) => {
    for (const [socket, state] of states) {
      if (state.participantId !== event.participantId) continue;
      send(socket, event);
      if (event.scope === "session") {
        state.closing = true;
        socket.close(4001, "removed from the session");
      } else if (state.roomId === event.roomId) {
        void leaveRoom(socket, state).catch(() => undefined);
      }
    }
  };

  /**
   * On every replica, not just the one that served the delete: a deleted
   * document stops being editable here (the per-socket check is forgotten) and
   * this replica's copy is released unsaved, or its editors' next keystrokes
   * would write rows for a document that no longer exists.
   */
  const forgetDeleted = (roomId: string, documents: { id: string }[]) => {
    const kept = new Set(documents.map((d) => d.id));
    for (const state of states.values()) {
      if (state.roomId !== roomId) continue;
      for (const id of state.docs) if (!kept.has(id)) state.docs.delete(id);
    }
    for (const key of docHub.keysOf(roomId)) {
      if (key === roomId) continue; // the main document is never deleted
      const docId = key.slice(roomId.length + 1);
      if (!kept.has(docId)) docHub.discard(key);
    }
  };

  pubsub.setHandlers({
    onRoomEvent(roomId, event) {
      if (event.type === "participant_removed") removeLocally(event);
      if (event.type === "documents_updated") forgetDeleted(roomId, event.documents);
      // The room is being deleted: its documents go with it, unsaved, on every
      // replica - a save racing the delete would only fail against a missing room.
      if (event.type === "room_deleted") for (const key of docHub.keysOf(roomId)) docHub.discard(key);
      if (event.type === "doc") {
        // The hub applies it to this replica's copy and forwards it to local
        // editors other than its author, with `from` stripped.
        try {
          docHub.relay(docKey(roomId, event.docId ?? MAIN_DOC_ID), event.data, event.from ?? "");
        } catch (err) {
          console.error("[docs] relay failed", err);
        }
        return;
      }
      const payload = JSON.stringify(event);
      for (const socket of roomRegistry.members(roomId)) {
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      }
    },
    onSessionEvent(sessionId, event) {
      if (event.type === "participant_removed") removeLocally(event);
      if (event.type === "session_ended") {
        // Its notes go unsaved: the rows are being deleted, and a save racing
        // that would only fail. Then every connection to it is told and closed.
        for (const roomId of event.roomIds) for (const key of docHub.keysOf(roomId)) docHub.discard(key);
        for (const [socket, state] of states) {
          if (state.sessionId !== sessionId) continue;
          send(socket, event);
          state.closing = true;
          socket.close(4003, "session ended");
        }
        return;
      }
      if (event.type === "admission_decided") {
        for (const [socket, state] of states) {
          if (state.participantId !== event.participantId || !state.pending) continue;
          send(socket, event);
          if (event.admitted) {
            void completeJoin(socket, state, sessionId).catch((err: unknown) => console.error("[ws] admit failed", err));
          } else {
            state.closing = true;
            socket.close(4002, "not let in");
          }
        }
      }
      const payload = JSON.stringify(event);
      for (const socket of sessionRegistry.members(sessionId)) {
        // Someone waiting hears nothing of the session but their own answer.
        if (states.get(socket)?.pending) continue;
        if (socket.readyState === WebSocket.OPEN) socket.send(payload);
      }
    },
  });

  /** Open connections per address on this replica, for the cap below. */
  const perAddress = new Map<string, number>();

  wss.on("connection", (socket, request) => {
    // The last entry: the one the load balancer appended. Earlier ones are
    // whatever the client sent, and trusting them would let anyone reset the
    // code-guessing limit by making one up. (Express's "trust proxy 1" does the same.)
    const forwarded = String(request.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim();
    const state: ConnectionState = {
      address: forwarded || request.socket.remoteAddress || "unknown",
      docs: new Set(),
      pending: false,
      closing: false,
      preferredRoomId: null,
      queue: Promise.resolve(),
      limits: socketLimits(),
      connId: nanoid(12),
      participantId: null,
      sessionId: null,
      displayName: null,
      roomId: null,
      alive: true,
    };
    // One address may hold this many connections at once. Generous - a class
    // on school wifi is one address - but finite: each open socket holds
    // memory, and a script could otherwise open them until the replica falls.
    const open = (perAddress.get(state.address) ?? 0) + 1;
    if (open > config.limits.connectionsPerAddress) {
      socket.close(1013, "too many connections from this address");
      return;
    }
    perAddress.set(state.address, open);
    socket.once("close", () => {
      const left = (perAddress.get(state.address) ?? 1) - 1;
      if (left > 0) perAddress.set(state.address, left);
      else perAddress.delete(state.address);
    });

    states.set(socket, state);

    socket.on("pong", () => {
      state.alive = true;
      // An open tab is a session in use, even an idle one. This, not the
      // participants' "connected" flags, is what keeps it from expiring: those
      // flags stay set forever for sockets a crashed replica never closed.
      // Throttled inside touch() to one write per session every few minutes.
      if (!state.pending && !state.closing) touch(state.sessionId);
      if (state.participantId && state.sessionId) void here(`session:${state.sessionId}`, state.participantId, state.connId);
      if (state.participantId && state.roomId) void here(`room:${state.roomId}`, state.participantId, state.connId);
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
      const event = result.data;
      state.queue = state.queue
        .then(() => handleEvent(socket, state, event))
        .catch((err: unknown) => {
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
