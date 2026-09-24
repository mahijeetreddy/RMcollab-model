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
  Session,
} from "./domain.js";

// ---------------------------------------------------------------------------
// WebSocket: client -> gateway
// ---------------------------------------------------------------------------

export type ClientEvent =
  | { type: "join_session"; sessionCode: string; displayName: string; participantId?: string }
  | { type: "join_room"; roomId: string; code?: string }
  | { type: "chat_message"; roomId: string; body: string }
  | { type: "typing"; roomId: string; isTyping: boolean }
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
      error?: string;
    }
  | { type: "pong" }
  | { type: "error"; code: string; message: string };

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
