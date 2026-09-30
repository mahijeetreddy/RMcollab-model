import type {
  Artifact,
  ArtifactKind,
  ChatMessage,
  EnhancementJob,
  JobStatus,
  MediaItem,
  MediaItemWithJob,
  MediaType,
  Participant,
  Room,
  RoomDocument,
  Session,
} from "./domain.js";

// ---------------------------------------------------------------------------
// WebSocket: client -> gateway
// ---------------------------------------------------------------------------

export type ClientEvent =
  // `roomId`: the room to be in, for a reconnect - entered straight away when
  // this person may, instead of the main room.
  | { type: "join_session"; sessionCode: string; displayName: string; participantId?: string; roomId?: string }
  | { type: "join_room"; roomId: string; code?: string }
  | { type: "chat_message"; roomId: string; body: string }
  | { type: "typing"; roomId: string; isTyping: boolean }
  // The room's shared notes. `data` is a base64 y-protocols message (sync or
  // awareness), carried on the same socket as everything else so the room's
  // access check guards the document too. See gateway/src/docs/roomDocs.ts.
  // `docId` names which of the room's documents; absent means its main notes.
  | { type: "doc"; roomId: string; data: string; docId?: string }
  // Ask the room. The answer comes back to this socket only - a question is
  // private to whoever asked it. `requestId` is chosen by the client, so it can
  // match replies to the question before the gateway has said anything.
  | { type: "ask"; roomId: string; requestId: string; question: string; history?: AskHistoryTurn[] }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// WebSocket: gateway -> client
// ---------------------------------------------------------------------------

export type ServerEvent =
  | { type: "session_joined"; session: Session; participant: Participant; rooms: Room[] }
  | {
      type: "room_state";
      roomId: string;
      participants: Participant[];
      chatHistory: ChatMessage[];
      media: MediaItemWithJob[];
    }
  | { type: "rooms_updated"; sessionId: string; rooms: Room[] }
  | { type: "participant_joined"; roomId: string; participant: Participant }
  | { type: "participant_left"; roomId: string; participantId: string }
  | { type: "chat_message"; roomId: string; message: ChatMessage }
  // Ephemeral: relayed to the room and never persisted. Receivers expire it on a
  // timer, so a sender that disconnects mid-keystroke cannot leave it stuck on.
  | {
      type: "typing";
      roomId: string;
      participantId: string;
      displayName: string;
      isTyping: boolean;
    }
  | { type: "media_uploaded"; roomId: string; mediaItem: MediaItem; job: EnhancementJob }
  // Renamed, or retried (a new job replaces the failed one).
  | { type: "media_updated"; roomId: string; mediaItem: MediaItem; job?: EnhancementJob }
  | { type: "media_deleted"; roomId: string; mediaItemId: string }
  // The room is gone; anyone in it is moved to the session's main room.
  | { type: "room_deleted"; roomId: string }
  // The session's code or settings changed (a new code after a removal, the waiting room switched).
  | { type: "session_updated"; session: Session }
  // Waiting room: this socket waits to be let in; nothing of the session is shown meanwhile.
  | { type: "admission_waiting"; sessionName: string | null; ownerName: string | null }
  // To the session: someone is waiting. Only the owner acts on it.
  | { type: "admission_requested"; sessionId: string; participant: { id: string; displayName: string } }
  // Decided: let in, or turned away.
  | { type: "admission_decided"; sessionId: string; participantId: string; admitted: boolean; byName: string }
  // Someone waiting gave up (closed the page, pressed Cancel): off the owner's list.
  | { type: "admission_withdrawn"; sessionId: string; participantId: string }
  // Someone was removed by the room's owner: from a breakout room ("room"),
  // or from the whole session ("session", when removed from the main room).
  | {
      type: "participant_removed";
      roomId: string;
      participantId: string;
      scope: "room" | "session";
      byName: string;
    }
  | {
      type: "job_status_update";
      roomId: string;
      jobId: string;
      mediaItemId: string;
      status: Extract<JobStatus, "queued" | "processing">;
      progress: number;
      message?: string;
    }
  | {
      type: "job_complete";
      roomId: string;
      jobId: string;
      mediaItemId: string;
      status: Extract<JobStatus, "done" | "failed">;
      /** Everything the job produced. Empty on failure. */
      artifacts: Artifact[];
      /** The worker's closing summary; replaces the last progress message. */
      message?: string;
      error?: string;
    }
  // Shared-notes traffic, same encoding as the client event. `from` names the
  // sending connection while the frame crosses Redis, so each replica can skip
  // echoing it back to its author; it is stripped before reaching a browser.
  | { type: "doc"; roomId: string; data: string; docId?: string; from?: string }
  // The room's list of documents changed: one was made, renamed or deleted.
  | { type: "documents_updated"; roomId: string; documents: RoomDocument[] }
  // Ask the room, to the asker only: the passages first, so citations can be
  // shown as the answer arrives; then the answer in pieces; then the end.
  | {
      type: "ask_sources";
      requestId: string;
      sources: AskSource[];
      /** A follow-up as it was understood and searched for, when it differs from what was typed. */
      standalone?: string;
    }
  | { type: "ask_delta"; requestId: string; text: string }
  | {
      type: "ask_done";
      requestId: string;
      /** The citations that point at a real source, in order of first use. */
      cited: number[];
      /** Set when no answer could be written; the sources are still worth showing. */
      fallback?: AskFallback;
      /** Set when nothing in the room matched the question at all. */
      noEvidence?: boolean;
      model?: string;
    }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

/** Why an answer could not be written. */
export type AskFallback = "no_model" | "quota" | "failed" | "timeout" | "rate_limited";

/** One passage an answer may cite, numbered as the model sees it. */
export interface AskSource {
  n: number;
  kind: "transcript" | "summary" | "document" | "notes";
  /** The upload's name, or the notes section's heading. */
  title: string;
  excerpt: string;
  mediaItemId: string | null;
  artifactId: string | null;
  /** Where a transcript passage starts, for seeking the player. */
  atSeconds: number | null;
  /** The notes section, for scrolling to it: an upload's media id, or a heading's index. */
  notesKey: string | null;
  /** Which of the room's documents a notes source is in; null for anything else. */
  docId: string | null;
}

// ---------------------------------------------------------------------------
// Redis pub/sub — room fan-out across gateway replicas.
// Channel: `rmcollab:room:<roomId>`. Payload is a ServerEvent plus the id of the
// replica that published it, so a replica can skip echoing to its own sockets
// when it has already delivered locally.
// ---------------------------------------------------------------------------

export const roomChannel = (roomId: string): string => `rmcollab:room:${roomId}`;
export const sessionChannel = (sessionId: string): string => `rmcollab:session:${sessionId}`;

export interface RoomBroadcast {
  originReplicaId: string;
  event: ServerEvent;
}

// ---------------------------------------------------------------------------
// Redis Stream — job lifecycle events emitted by workers.
// Consumed by the gateway (-> WS fan-out) and, from Phase 3, by the webhook
// dispatcher. Stream key below; each entry is a single field `payload` holding
// the JSON-encoded JobEvent.
// ---------------------------------------------------------------------------

export const JOB_EVENT_STREAM = "rmcollab:job-events";

export interface JobEvent {
  jobId: string;
  mediaItemId: string;
  roomId: string;
  sessionId: string;
  mediaType: MediaType;
  strategy: string;
  status: JobStatus;
  /** 0..1 */
  progress: number;
  message?: string;
  /** Present on a `done` event. Storage-relative paths, not URLs: the gateway
   *  signs them when it serves them, so a worker never mints a public link. */
  artifacts?: JobEventArtifact[];
  error?: string;
  emittedAt: number;
}

export interface JobEventArtifact {
  kind: ArtifactKind;
  label: string;
  /** Storage-relative, e.g. rooms/<roomId>/<mediaItemId>/enhanced.png */
  path: string;
  mimeType?: string;
  meta?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Celery task payload — the kwargs the gateway sends to workers.
// Task name is TASK_ENHANCE, routed to a queue per media type (QUEUES).
// ---------------------------------------------------------------------------

export const TASK_ENHANCE = "rmcollab.enhance";

export const QUEUES: Record<MediaType, string> = {
  text: "enhance.text",
  image: "enhance.image",
  audio: "enhance.audio",
  video: "enhance.video",
};

export interface EnhanceTaskPayload {
  job_id: string;
  media_item_id: string;
  room_id: string;
  session_id: string;
  media_type: MediaType;
  strategy: string;
  /** Storage-relative path of the uploaded original. */
  input_path: string;
  /** Storage-relative path the worker should write its result to. */
  output_path: string;
  params: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Ask the room: gateway <-> worker. Mirrored in workers/common/contracts.py.
//
// Embedding runs in a worker (the model is Python), retrieval in the gateway
// (it owns the database), so a question makes two trips: the worker embeds it
// and the notes, the gateway ranks passages, then the worker writes the answer.
// Replies travel on a per-request pub/sub channel that only the asking socket's
// replica listens on; document embeddings go on a stream, consumed once.
// ---------------------------------------------------------------------------

export const TASK_EMBED_PASSAGES = "rmcollab.embed_passages";
export const TASK_ASK_PREPARE = "rmcollab.ask_prepare";
export const TASK_ASK_ANSWER = "rmcollab.ask_answer";
/** Questions: a queue of its own, so an answer never waits behind a summary. */
export const QUEUE_ASK = "ask";
/** Document embeddings, drained by the same pool in small batches. */
export const QUEUE_EMBED = "embed";
export const EMBEDDING_STREAM = "rmcollab:embeddings";
export const ASK_CHANNEL_PREFIX = "rmcollab:ask:";
export const askChannel = (requestId: string): string => `${ASK_CHANNEL_PREFIX}${requestId}`;
// Chosen by measurement against e2e/fixtures/ask-eval.json with
// workers/tools/eval_embeddings.py; see the README's Ask the room section.
export const EMBEDDING_MODEL = "snowflake/snowflake-arctic-embed-m";
export const EMBEDDING_DIMENSIONS = 768;

/** A text to embed: a passage (id = its row) or a notes section (id = its key). */
export interface EmbedItem {
  id: string;
  text: string;
}

export interface EmbedPassagesTask {
  items: EmbedItem[];
}

/** A vector as base64 of little-endian float32s: a quarter the size of JSON numbers. */
export interface EmbeddedVector {
  id: string;
  vector: string;
}

/** An EMBEDDING_STREAM entry's `payload`. */
export interface EmbeddingResult {
  model: string;
  vectors: EmbeddedVector[];
}

/** An earlier question and its answer, so a follow-up can be understood. */
export interface AskHistoryTurn {
  question: string;
  answer: string;
}

export interface AskPrepareTask {
  request_id: string;
  question: string;
  notes: EmbedItem[];
  /** Earlier turns, oldest first; empty for a first question. */
  history: AskHistoryTurn[];
}

export interface AskPassage {
  n: number;
  /** How the passage is introduced to the model, e.g. "Recording lecture.mp3, at 12:04". */
  source: string;
  text: string;
}

export interface AskAnswerTask {
  request_id: string;
  question: string;
  passages: AskPassage[];
}

export type AskReplyType = "vectors" | "delta" | "done" | "error";

/** A message on askChannel(requestId). Which fields are set depends on `type`. */
export interface AskReply {
  type: AskReplyType;
  /** vectors: the question's embedding. */
  question?: string;
  /** vectors: a follow-up rewritten to stand on its own; what was embedded. */
  standalone?: string;
  /** vectors: each notes section's embedding. */
  notes?: EmbeddedVector[];
  /** delta: the next piece of the answer. */
  text?: string;
  /** done: which model wrote it. */
  model?: string;
  /** error: why no answer could be written. */
  code?: string;
  message?: string;
}
