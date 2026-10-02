import type {
  ChatMessage,
  EnhancementJob,
  MediaItemWithJob,
  Participant,
  Room,
  ServerEvent,
  Session, RoomDocument } from "@rmcollab/shared";

export interface RealtimeError {
  code: string;
  message: string;
  at: number;
}

export interface RoomState {
  session: Session | null;
  /** The local participant, as the gateway identified us on `session_joined`. */
  me: Participant | null;
  rooms: Room[];
  activeRoomId: string | null;
  /** False between asking to join a room and its `room_state` snapshot arriving. */
  synced: boolean;
  /**
   * The room whose snapshot is on screen. Unlike `synced`, kept through a
   * reconnect: the room stays up while the socket comes back, so the notes
   * editor keeps its document - and any edits not yet sent, which the resync
   * then delivers. Taking the view down on every blip destroyed them.
   */
  loadedRoomId: string | null;
  participants: Participant[];
  chat: ChatMessage[];
  media: MediaItemWithJob[];
  /** Who is typing right now, keyed by participant id. Entries carry the time
   *  they arrived so a stale one can be pruned if the sender goes quiet. */
  typing: Record<string, { displayName: string; at: number }>;
  lastError: RealtimeError | null;
  /** Waiting room: set while this browser waits to be let in, or once it was turned away. */
  admission: { status: "waiting"; sessionName: string | null; ownerName: string | null } | { status: "denied"; byName: string } | null;
  /** Set when the session's owner ended it: everything in it is being deleted. */
  ended: { byName: string; at: number } | null;
  /** The latest handover of the session, for telling people who owns it now. */
  ownerChange: { ownerId: string; ownerName: string; byName: string; at: number } | null;
  /** For the owner: who is waiting, and whose request has been answered. */
  waitingList: { id: string; displayName: string }[];
  admissionDecided: string[];
  /** The room's documents, as last announced; null until the first announcement. */
  documents: RoomDocument[] | null;
  /** Set when the room's owner removed us; RoomView and App act on it. */
  removed: { scope: "room" | "session"; roomId: string; byName: string; at: number } | null;
}

export const initialRoomState: RoomState = {
  session: null,
  me: null,
  rooms: [],
  activeRoomId: null,
  synced: false,
  loadedRoomId: null,
  participants: [],
  chat: [],
  media: [],
  typing: {},
  lastError: null,
  admission: null,
  ended: null,
  ownerChange: null,
  waitingList: [],
  admissionDecided: [],
  documents: null,
  removed: null,
};

export type RoomAction =
  | { type: "server_event"; event: ServerEvent }
  | { type: "invalid_event"; reason: string }
  | { type: "room_requested"; roomId: string }
  | { type: "connection_lost" }
  | { type: "clear_error" }
  | { type: "prune_typing"; olderThan: number }
  | { type: "reset" };

function sortRooms(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

function upsertParticipant(list: Participant[], participant: Participant): Participant[] {
  const index = list.findIndex((p) => p.id === participant.id);
  if (index === -1) return [...list, participant];
  const next = [...list];
  next[index] = participant;
  return next;
}

/** Jobs are addressed by `mediaItemId`, not job id: the client indexes media by
 *  item and a retry may carry a new job id for the same item. */
function patchJob(
  media: MediaItemWithJob[],
  mediaItemId: string,
  patch: (job: EnhancementJob | null) => EnhancementJob | null,
): MediaItemWithJob[] {
  const index = media.findIndex((entry) => entry.mediaItem.id === mediaItemId);
  if (index === -1) return media;
  const entry = media[index];
  if (!entry) return media;
  const job = patch(entry.job);
  if (job === entry.job) return media;
  const next = [...media];
  next[index] = { mediaItem: entry.mediaItem, job };
  return next;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function applyServerEvent(state: RoomState, event: ServerEvent): RoomState {
  switch (event.type) {
    case "session_joined":
      return {
        ...state,
        admission: null,
        session: event.session,
        me: event.participant,
        rooms: sortRooms(event.rooms),
      };

    case "rooms_updated":
      return { ...state, rooms: sortRooms(event.rooms) };

    // Authoritative snapshot. It replaces room-scoped state wholesale, which is
    // what makes reconnect a resync rather than a merge of whatever we missed.
    case "room_state":
      return {
        ...state,
        activeRoomId: event.roomId,
        synced: true,
        loadedRoomId: event.roomId,
        // Entering successfully resolves whatever refused the previous attempt
        // (a missing or wrong room code), so the prompt must not linger.
        lastError: null,
        participants: event.participants,
        documents: state.activeRoomId === event.roomId ? state.documents : null,
        chat: [...event.chatHistory].sort((a, b) => a.createdAt - b.createdAt),
        media: [...event.media].sort((a, b) => b.mediaItem.createdAt - a.mediaItem.createdAt),
      };

    case "error":
      return {
        ...state,
        lastError: { code: event.code, message: event.message, at: Date.now() },
      };

    case "pong":
      return state;

    case "participant_joined":
      if (!isCurrentRoom(state, event.roomId)) return state;
      return { ...state, participants: upsertParticipant(state.participants, event.participant) };

    case "session_updated":
      return { ...state, session: event.session };

    case "admission_waiting":
      return { ...state, admission: { status: "waiting", sessionName: event.sessionName, ownerName: event.ownerName } };

    case "admission_requested":
      if (state.waitingList.some((p) => p.id === event.participant.id)) return state;
      return {
        ...state,
        waitingList: [...state.waitingList, event.participant],
        admissionDecided: state.admissionDecided.filter((id) => id !== event.participant.id),
      };

    case "admission_decided":
      // While this browser waits, the only decision it hears is its own.
      if (state.admission?.status === "waiting") {
        return event.admitted ? state : { ...state, admission: { status: "denied", byName: event.byName } };
      }
      return {
        ...state,
        waitingList: state.waitingList.filter((p) => p.id !== event.participantId),
        admissionDecided: [...state.admissionDecided, event.participantId],
      };

    case "session_ended":
      return { ...state, ended: { byName: event.byName, at: Date.now() } };

    case "owner_changed":
      return {
        ...state,
        ownerChange: { ownerId: event.ownerId, ownerName: event.ownerName, byName: event.byName, at: Date.now() },
      };

    case "chat_message_deleted":
      if (!isCurrentRoom(state, event.roomId)) return state;
      return { ...state, chat: state.chat.filter((m) => m.id !== event.messageId) };

    case "admission_withdrawn":
      return {
        ...state,
        waitingList: state.waitingList.filter((p) => p.id !== event.participantId),
        admissionDecided: [...state.admissionDecided, event.participantId],
      };

    case "documents_updated":
      if (!isCurrentRoom(state, event.roomId)) return state;
      return { ...state, documents: event.documents };

    case "participant_removed":
      if (state.me && event.participantId === state.me.id) {
        return { ...state, removed: { scope: event.scope, roomId: event.roomId, byName: event.byName, at: Date.now() } };
      }
      return { ...state, participants: state.participants.filter((p) => p.id !== event.participantId) };

    case "participant_left":
      if (!isCurrentRoom(state, event.roomId)) return state;
      return {
        ...state,
        participants: state.participants.filter((p) => p.id !== event.participantId),
      };

    case "chat_message": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      if (state.chat.some((m) => m.id === event.message.id)) return state;
      // Sending clears the sender's own indicator without waiting for a timeout.
      const { [event.message.participantId]: _sent, ...typing } = state.typing;
      return { ...state, chat: [...state.chat, event.message], typing };
    }

    case "typing": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      if (event.participantId === state.me?.id) return state;
      if (!event.isTyping) {
        if (!(event.participantId in state.typing)) return state;
        const { [event.participantId]: _stopped, ...rest } = state.typing;
        return { ...state, typing: rest };
      }
      return {
        ...state,
        typing: {
          ...state.typing,
          [event.participantId]: { displayName: event.displayName, at: Date.now() },
        },
      };
    }

    case "media_uploaded": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      if (state.media.some((entry) => entry.mediaItem.id === event.mediaItem.id)) return state;
      return {
        ...state,
        media: [{ mediaItem: event.mediaItem, job: event.job }, ...state.media],
      };
    }

    case "media_updated": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      return {
        ...state,
        media: state.media.map((entry) =>
          entry.mediaItem.id === event.mediaItem.id
            ? { mediaItem: event.mediaItem, job: event.job ?? entry.job }
            : entry,
        ),
      };
    }

    case "media_deleted": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      return { ...state, media: state.media.filter((entry) => entry.mediaItem.id !== event.mediaItemId) };
    }

    case "room_deleted":
      // The room list update that follows moves anyone inside to the main room
      // (RoomView); nothing of the gone room is worth keeping in the meantime.
      if (!isCurrentRoom(state, event.roomId)) return state;
      return { ...state, media: [], chat: [], synced: false, loadedRoomId: null };

    case "job_status_update": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      return {
        ...state,
        media: patchJob(state.media, event.mediaItemId, (job) =>
          job
            ? {
                ...job,
                id: event.jobId,
                status: event.status,
                progress: clamp01(event.progress),
                message: event.message ?? job.message,
                startedAt: job.startedAt ?? (event.status === "processing" ? Date.now() : null),
              }
            : job,
        ),
      };
    }

    case "job_complete": {
      if (!isCurrentRoom(state, event.roomId)) return state;
      return {
        ...state,
        media: patchJob(state.media, event.mediaItemId, (job) =>
          job
            ? {
                ...job,
                id: event.jobId,
                status: event.status,
                progress: event.status === "done" ? 1 : job.progress,
                artifacts: event.artifacts.length > 0 ? event.artifacts : job.artifacts,
                message: event.message ?? job.message,
                error: event.error ?? (event.status === "failed" ? job.error : null),
                completedAt: Date.now(),
              }
            : job,
        ),
      };
    }

    case "doc":
      // Routed to the notes editor before the reducer (useRealtime); the room's
      // document lives in its CRDT, not in this state.
      return state;

    case "ask_sources":
    case "ask_delta":
    case "ask_done":
      // Also routed before the reducer, to the Ask panel: an answer is private
      // to its asker and arrives in pieces, so it is not room state.
      return state;

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

/** Incremental events are dropped until the snapshot for that room lands, so a
 *  mid-switch or mid-reconnect event can never be applied to the wrong room. */
function isCurrentRoom(state: RoomState, roomId: string): boolean {
  return state.synced && state.activeRoomId === roomId;
}

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case "server_event":
      return applyServerEvent(state, action.event);

    // The frame was already discarded at the socket; surface it rather than
    // leaving the room looking healthy while it quietly stops updating.
    case "invalid_event":
      return {
        ...state,
        lastError: { code: "invalid_server_event", message: action.reason, at: Date.now() },
      };

    case "room_requested":
      if (state.activeRoomId === action.roomId && state.synced) return state;
      return {
        ...state,
        activeRoomId: action.roomId,
        synced: false,
        // Another room: this one's view goes. The same room (a rejoin) stays up.
        loadedRoomId: state.loadedRoomId === action.roomId ? state.loadedRoomId : null,
        participants: [],
        chat: [],
        media: [],
        typing: {},
      };

    // The socket dropped: the view is stale until the next snapshot replaces it.
    case "connection_lost":
      // Typing is ephemeral peer state; a dropped socket means we will never be
      // told they stopped, so clear it rather than leave it stuck on.
      if (!state.synced && Object.keys(state.typing).length === 0) return state;
      return { ...state, synced: false, typing: {} };

    case "prune_typing": {
      const live = Object.entries(state.typing).filter(([, v]) => v.at >= action.olderThan);
      if (live.length === Object.keys(state.typing).length) return state;
      return { ...state, typing: Object.fromEntries(live) };
    }

    case "clear_error":
      return state.lastError ? { ...state, lastError: null } : state;

    case "reset":
      return initialRoomState;

    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}
