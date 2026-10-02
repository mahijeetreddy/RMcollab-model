export type MediaType = "text" | "image" | "audio" | "video";

export type JobStatus = "queued" | "processing" | "done" | "failed";

export interface Session {
  id: string;
  code: string;
  name: string | null;
  createdAt: number;
  /** New people wait until the session's owner lets them in. */
  waitingRoom: boolean;
  /** The owner chose to keep it through longer quiet spells. */
  kept: boolean;
  /** Days without activity before it is deleted, everything in it: what `kept` decides. */
  retentionDays: number;
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
  /** A name given to it; null means use the file name. See mediaTitle(). */
  title: string | null;
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
  title: string | null;
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
  /** Why it cannot run right now, in words for a person; null while it can. */
  unavailableReason?: string | null;
}

const MEDIA_TITLE_LABEL: Record<MediaType, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };

/**
 * What an upload is called everywhere it appears - feed, notes, library, Ask:
 * the name someone gave it, else its file name, else "Recording from Alice".
 */
export function mediaTitle(item: {
  title: string | null;
  originalFilename: string | null;
  mediaType: MediaType;
  uploaderName: string;
}): string {
  return item.title?.trim() || item.originalFilename || `${MEDIA_TITLE_LABEL[item.mediaType]} from ${item.uploaderName}`;
}

/** The longest title an upload may be given. */
export const MAX_TITLE_CHARS = 120;

/**
 * A title for pasted text from its first words, so it is not "Text from
 * Alice" three times over: the first line, cut at a word near 60 characters.
 */
export function titleFromText(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^#+\s*|[*_`>]+/g, "").trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).replace(/[,;:.-]+$/, "")}…`;
}

/**
 * Session codes: 10 characters from an alphabet without look-alikes (no I, O,
 * 0 or 1), about 50 bits - guessing one is hopeless, where 6 characters could
 * be enumerated. Shown split in two for reading aloud; typed with or without
 * the dash, in any case. Codes from before the change (6 characters) still work.
 */
export const SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const SESSION_CODE_LENGTH = 10;

/** What someone typed, as the code is stored: dashes and spaces gone, upper case. */
export function normalizeSessionCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

/** "ABCDE23456" -> "ABCDE-23456". Anything else is shown as it is. */
export function formatSessionCode(code: string): string {
  const clean = normalizeSessionCode(code);
  return clean.length === SESSION_CODE_LENGTH ? `${clean.slice(0, 5)}-${clean.slice(5)}` : clean;
}

/** One of a room's documents. */
export interface RoomDocument {
  id: string;
  roomId: string;
  title: string;
  /** The room's own notes, where uploads land. Every room has exactly one; it cannot be deleted. */
  isMain: boolean;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: number;
  updatedAt: number;
}
