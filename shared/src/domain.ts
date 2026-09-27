export type MediaType = "text" | "image" | "audio" | "video";

export type JobStatus = "queued" | "processing" | "done" | "failed";

export interface Session {
  id: string;
  code: string;
  name: string | null;
  createdAt: number;
}

export interface Room {
  id: string;
  sessionId: string;
  name: string;
  isMain: boolean;
  /** Entry requires the room's code. The code itself is never sent to clients. */
  isLocked: boolean;
  /** Participant who created the room. Null for the session's main room, which
   *  exists before anyone has joined. */
  ownerId: string | null;
  createdAt: number;
}

export interface Participant {
  id: string;
  sessionId: string;
  displayName: string;
  currentRoomId: string | null;
  connected: boolean;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  participantId: string;
  displayName: string;
  body: string;
  createdAt: number;
}

export interface MediaItem {
  id: string;
  roomId: string;
  uploaderId: string;
  uploaderName: string;
  mediaType: MediaType;
  originalFilename: string | null;
  originalUrl: string;
  mimeType: string | null;
  sizeBytes: number | null;
  createdAt: number;
}

/**
 * One output of a job. A strategy that enhances produces a single `enhanced`
 * artifact; a comprehension strategy produces several (a transcript and a
 * summary), which is why a job no longer has one result.
 */
export type ArtifactKind = "enhanced" | "transcript" | "summary";

export interface Artifact {
  id: string;
  jobId: string;
  kind: ArtifactKind;
  label: string;
  url: string;
  mimeType: string | null;
  sizeBytes: number | null;
  /** Per-kind detail: segment timings for a transcript, model/tokens for a summary. */
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface EnhancementJob {
  id: string;
  mediaItemId: string;
  mediaType: MediaType;
  strategy: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  artifacts: Artifact[];
  error: string | null;
  attemptCount: number;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
}

/**
 * One searchable document in a room's library: an artifact plus enough about
 * the upload it came from to say what it is without loading the room feed.
 */
export interface LibraryEntry {
  artifact: Artifact;
  mediaItemId: string;
  mediaType: MediaType;
  originalFilename: string | null;
  uploaderName: string;
  strategy: string;
  /**
   * A passage of the document's text. For a search, the matched terms are
   * wrapped in LIBRARY_MATCH_START / LIBRARY_MATCH_END - control characters
   * rather than markup, so the client never has to trust HTML from the server.
   */
  snippet: string | null;
  /** For a transcript hit, where in the recording the first match is spoken. */
  atSeconds: number | null;
}

export const LIBRARY_MATCH_START = "\u0002";
export const LIBRARY_MATCH_END = "\u0003";

export interface MediaItemWithJob {
  mediaItem: MediaItem;
  job: EnhancementJob | null;
}

/** A registered enhancement approach, surfaced to the client's strategy picker. */
export interface StrategyDescriptor {
  mediaType: MediaType;
  name: string;
  label: string;
  description: string;
  isDefault: boolean;
  available: boolean;
}
