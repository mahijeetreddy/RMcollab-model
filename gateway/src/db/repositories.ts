import type {
  Artifact,
  ArtifactKind,
  ChatMessage,
  EnhancementJob,
  JobEvent,
  JobStatus,
  MediaItem,
  MediaItemWithJob,
  MediaType,
  Participant,
  Room,
  Session,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEventPayload,
} from "@rmcollab/shared";
import { customAlphabet, nanoid } from "nanoid";
import { storage } from "../storage/local.js";
import { pool } from "./pool.js";

// Ambiguity-free alphabet: join codes get read aloud and retyped.
const joinCode = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

interface SessionRow {
  id: string;
  code: string;
  name: string | null;
  created_at: number;
}

interface RoomRow {
  id: string;
  session_id: string;
  name: string;
  is_main: boolean;
  is_locked: boolean;
  owner_id: string | null;
  created_at: number;
}

interface ParticipantRow {
  id: string;
  session_id: string;
  display_name: string;
  current_room_id: string | null;
  connected: boolean;
  joined_at: number;
}

interface ChatMessageRow {
  id: string;
  room_id: string;
  participant_id: string;
  display_name: string;
  body: string;
  created_at: number;
}

interface MediaItemRow {
  id: string;
  room_id: string;
  uploader_id: string;
  uploader_name: string;
  media_type: MediaType;
  original_filename: string | null;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  created_at: number;
}

interface ArtifactRow {
  id: string;
  job_id: string;
  kind: ArtifactKind;
  label: string;
  storage_path: string;
  mime_type: string | null;
  size_bytes: number | null;
  meta: Record<string, unknown> | null;
  created_at: number;
}

interface JobRow {
  id: string;
  media_item_id: string;
  media_type: MediaType;
  strategy: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  artifacts: ArtifactRow[] | null;
  error: string | null;
  attempt_count: number;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
}

const toSession = (row: SessionRow): Session => ({
  id: row.id,
  code: row.code,
  name: row.name,
  createdAt: row.created_at,
});

// access_code is never selected into RoomRow: a room's code must not be able to
// leak to clients through a room listing.
const ROOM_COLS =
  "id, session_id, name, is_main, (access_code IS NOT NULL) AS is_locked, created_by AS owner_id, created_at";

const toRoom = (row: RoomRow): Room => ({
  id: row.id,
  sessionId: row.session_id,
  name: row.name,
  isMain: row.is_main,
  isLocked: row.is_locked,
  ownerId: row.owner_id,
  createdAt: row.created_at,
});

const toParticipant = (row: ParticipantRow): Participant => ({
  id: row.id,
  sessionId: row.session_id,
  displayName: row.display_name,
  currentRoomId: row.current_room_id,
  connected: row.connected,
  joinedAt: row.joined_at,
});

const toChatMessage = (row: ChatMessageRow): ChatMessage => ({
  id: row.id,
  roomId: row.room_id,
  participantId: row.participant_id,
  displayName: row.display_name,
  body: row.body,
  createdAt: row.created_at,
});

const toMediaItem = (row: MediaItemRow): MediaItem => ({
  id: row.id,
  roomId: row.room_id,
  uploaderId: row.uploader_id,
  uploaderName: row.uploader_name,
  mediaType: row.media_type,
  originalFilename: row.original_filename,
  originalUrl: storage.publicUrl(row.storage_path),
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes,
  createdAt: row.created_at,
});

const toJob = (row: JobRow): EnhancementJob => ({
  id: row.id,
  mediaItemId: row.media_item_id,
  mediaType: row.media_type,
  strategy: row.strategy,
  status: row.status,
  progress: Number(row.progress),
  message: row.message,
  artifacts: (row.artifacts ?? []).map(toArtifact),
  error: row.error,
  attemptCount: row.attempt_count,
  createdAt: row.created_at,
  startedAt: row.started_at,
  completedAt: row.completed_at,
});

const PARTICIPANT_COLS =
  "id, session_id, display_name, current_room_id, connected, joined_at";

const toArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  jobId: row.job_id,
  kind: row.kind,
  label: row.label,
  url: storage.publicUrl(row.storage_path),
  mimeType: row.mime_type,
  sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  meta: row.meta ?? {},
  createdAt: Number(row.created_at),
});

/** Artifacts come back with the job in one round trip rather than an N+1 per job. */
const artifactsJson = (jobAlias: string): string => `COALESCE((
       SELECT json_agg(a ORDER BY a.created_at, a.id)
       FROM job_artifacts a WHERE a.job_id = ${jobAlias}.id
     ), '[]'::json) AS artifacts`;

/** Plain columns, for RETURNING on writes. Artifacts are read back separately. */
const JOB_COLS_BASE = `id, media_item_id, media_type, strategy, status, progress, message,
   error, attempt_count, created_at, started_at, completed_at`;

const JOB_COLS = `${JOB_COLS_BASE}, ${artifactsJson("enhancement_jobs")}`;

// --- sessions ---------------------------------------------------------------

export async function createSession(name: string | null): Promise<Session> {
  const now = Date.now();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = joinCode();
    const { rows } = await pool.query<SessionRow>(
      `INSERT INTO sessions (id, code, name, created_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING
       RETURNING id, code, name, created_at`,
      [nanoid(16), code, name, now],
    );
    const row = rows[0];
    if (row) return toSession(row);
  }
  throw new Error("could not allocate a unique session code");
}

export async function getSessionByCode(code: string): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, code, name, created_at FROM sessions WHERE code = $1`,
    [code.toUpperCase()],
  );
  const row = rows[0];
  return row ? toSession(row) : null;
}

export async function getSessionById(id: string): Promise<Session | null> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, code, name, created_at FROM sessions WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toSession(row) : null;
}

// --- rooms ------------------------------------------------------------------

export async function createRoom(
  sessionId: string,
  name: string,
  isMain = false,
  accessCode: string | null = null,
  ownerId: string | null = null,
): Promise<Room> {
  const { rows } = await pool.query<RoomRow>(
    `INSERT INTO rooms (id, session_id, name, is_main, access_code, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${ROOM_COLS}`,
    [nanoid(16), sessionId, name, isMain, accessCode, ownerId, Date.now()],
  );
  const room = toRoom(rows[0]!);

  // The creator is admitted to their own room: otherwise setting a code locks
  // you out of the room you just made and prompts you for it.
  if (ownerId) {
    await pool.query(
      `INSERT INTO room_members (room_id, participant_id, granted_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [room.id, ownerId, Date.now()],
    );
  }
  return room;
}

/** The room's code, but only for its owner. Null for anyone else. */
export async function getRoomCodeForOwner(
  roomId: string,
  participantId: string,
): Promise<string | null> {
  const { rows } = await pool.query<{ access_code: string | null }>(
    `SELECT access_code FROM rooms WHERE id = $1 AND created_by = $2`,
    [roomId, participantId],
  );
  return rows[0]?.access_code ?? null;
}

export type RoomAccess = "open" | "granted" | "code_required" | "code_invalid";

/**
 * Decides whether a participant may enter a room, and records the grant when a
 * correct code is presented so a reconnect or room switch does not ask again.
 */
export async function resolveRoomAccess(
  roomId: string,
  participantId: string,
  code: string | undefined,
): Promise<RoomAccess> {
  const { rows } = await pool.query<{ access_code: string | null }>(
    `SELECT access_code FROM rooms WHERE id = $1`,
    [roomId],
  );
  const room = rows[0];
  if (!room || room.access_code === null) return "open";

  const { rowCount } = await pool.query(
    `SELECT 1 FROM room_members WHERE room_id = $1 AND participant_id = $2`,
    [roomId, participantId],
  );
  if (rowCount) return "granted";

  if (!code) return "code_required";
  if (code.trim().toUpperCase() !== room.access_code.toUpperCase()) return "code_invalid";

  await pool.query(
    `INSERT INTO room_members (room_id, participant_id, granted_at)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [roomId, participantId, Date.now()],
  );
  return "granted";
}

/** Membership check with no side effects, for authorising non-WS routes. */
export async function hasRoomAccess(roomId: string, participantId: string): Promise<boolean> {
  const access = await resolveRoomAccess(roomId, participantId, undefined);
  return access === "open" || access === "granted";
}

export async function listRooms(sessionId: string): Promise<Room[]> {
  const { rows } = await pool.query<RoomRow>(
    `SELECT ${ROOM_COLS}
     FROM rooms WHERE session_id = $1
     ORDER BY is_main DESC, created_at ASC`,
    [sessionId],
  );
  return rows.map(toRoom);
}

export async function getRoom(roomId: string): Promise<Room | null> {
  const { rows } = await pool.query<RoomRow>(
    `SELECT ${ROOM_COLS} FROM rooms WHERE id = $1`,
    [roomId],
  );
  const row = rows[0];
  return row ? toRoom(row) : null;
}

// --- participants -----------------------------------------------------------

export async function upsertParticipant(input: {
  participantId?: string;
  sessionId: string;
  displayName: string;
}): Promise<Participant> {
  const now = Date.now();

  if (input.participantId) {
    const { rows } = await pool.query<ParticipantRow>(
      `UPDATE participants
       SET display_name = $3, connected = TRUE, last_seen_at = $4
       WHERE id = $1 AND session_id = $2
       RETURNING ${PARTICIPANT_COLS}`,
      [input.participantId, input.sessionId, input.displayName, now],
    );
    const row = rows[0];
    if (row) return toParticipant(row);
  }

  const { rows } = await pool.query<ParticipantRow>(
    `INSERT INTO participants
       (id, session_id, display_name, current_room_id, connected, joined_at, last_seen_at)
     VALUES ($1, $2, $3, NULL, TRUE, $4, $4)
     RETURNING ${PARTICIPANT_COLS}`,
    [nanoid(16), input.sessionId, input.displayName, now],
  );
  return toParticipant(rows[0]!);
}

export async function getParticipant(id: string): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLS} FROM participants WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

export async function setParticipantRoom(
  participantId: string,
  roomId: string | null,
): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `UPDATE participants SET current_room_id = $2, last_seen_at = $3
     WHERE id = $1
     RETURNING ${PARTICIPANT_COLS}`,
    [participantId, roomId, Date.now()],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

export async function setParticipantConnected(
  participantId: string,
  connected: boolean,
): Promise<Participant | null> {
  const { rows } = await pool.query<ParticipantRow>(
    `UPDATE participants SET connected = $2, last_seen_at = $3
     WHERE id = $1
     RETURNING ${PARTICIPANT_COLS}`,
    [participantId, connected, Date.now()],
  );
  const row = rows[0];
  return row ? toParticipant(row) : null;
}

export async function listRoomParticipants(roomId: string): Promise<Participant[]> {
  const { rows } = await pool.query<ParticipantRow>(
    `SELECT ${PARTICIPANT_COLS}
     FROM participants
     WHERE current_room_id = $1 AND connected = TRUE
     ORDER BY joined_at ASC`,
    [roomId],
  );
  return rows.map(toParticipant);
}

// --- chat -------------------------------------------------------------------

export async function insertChatMessage(input: {
  roomId: string;
  participantId: string;
  body: string;
}): Promise<ChatMessage | null> {
  const { rows } = await pool.query<ChatMessageRow>(
    `WITH inserted AS (
       INSERT INTO chat_messages (id, room_id, participant_id, body, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, room_id, participant_id, body, created_at
     )
     SELECT inserted.*, p.display_name
     FROM inserted JOIN participants p ON p.id = inserted.participant_id`,
    [nanoid(16), input.roomId, input.participantId, input.body, Date.now()],
  );
  const row = rows[0];
  return row ? toChatMessage(row) : null;
}

export async function listRecentChatMessages(
  roomId: string,
  limit: number,
): Promise<ChatMessage[]> {
  const { rows } = await pool.query<ChatMessageRow>(
    `SELECT m.id, m.room_id, m.participant_id, m.body, m.created_at, p.display_name
     FROM chat_messages m
     JOIN participants p ON p.id = m.participant_id
     WHERE m.room_id = $1
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2`,
    [roomId, limit],
  );
  return rows.map(toChatMessage).reverse();
}

// --- media & jobs -----------------------------------------------------------

export async function insertMediaItem(input: {
  roomId: string;
  uploaderId: string;
  mediaType: MediaType;
  originalFilename: string | null;
  storagePath: string;
  mimeType: string | null;
  sizeBytes: number | null;
  id?: string;
}): Promise<MediaItem | null> {
  const { rows } = await pool.query<MediaItemRow>(
    `WITH inserted AS (
       INSERT INTO media_items
         (id, room_id, uploader_id, media_type, original_filename, storage_path, mime_type, size_bytes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *
     )
     SELECT inserted.*, p.display_name AS uploader_name
     FROM inserted JOIN participants p ON p.id = inserted.uploader_id`,
    [
      input.id ?? nanoid(16),
      input.roomId,
      input.uploaderId,
      input.mediaType,
      input.originalFilename,
      input.storagePath,
      input.mimeType,
      input.sizeBytes,
      Date.now(),
    ],
  );
  const row = rows[0];
  return row ? toMediaItem(row) : null;
}

export async function insertJob(input: {
  mediaItemId: string;
  mediaType: MediaType;
  strategy: string;
  id?: string;
}): Promise<EnhancementJob> {
  const { rows } = await pool.query<JobRow>(
    `INSERT INTO enhancement_jobs
       (id, media_item_id, media_type, strategy, status, progress, created_at)
     VALUES ($1, $2, $3, $4, 'queued', 0, $5)
     RETURNING ${JOB_COLS}`,
    [input.id ?? nanoid(16), input.mediaItemId, input.mediaType, input.strategy, Date.now()],
  );
  return toJob(rows[0]!);
}

export async function getJob(jobId: string): Promise<EnhancementJob | null> {
  const { rows } = await pool.query<JobRow>(
    `SELECT ${JOB_COLS} FROM enhancement_jobs WHERE id = $1`,
    [jobId],
  );
  const row = rows[0];
  return row ? toJob(row) : null;
}

/**
 * Applies a worker JobEvent. Returns null when the row is unknown or already
 * terminal, which is how redelivered stream entries are absorbed.
 */
export async function updateJobFromEvent(event: JobEvent): Promise<EnhancementJob | null> {
  const now = event.emittedAt || Date.now();
  const terminal = event.status === "done" || event.status === "failed";
  const { rows } = await pool.query<JobRow>(
    `UPDATE enhancement_jobs SET
       status = $2,
       progress = $3,
       message = COALESCE($4, message),
       error = COALESCE($5, error),
       -- the worker reports the strategy that actually ran, which differs from
       -- the requested one whenever resolution fell back
       strategy = COALESCE($8, strategy),
       attempt_count = CASE
         WHEN $2 = 'processing' AND status <> 'processing' THEN attempt_count + 1
         ELSE attempt_count END,
       started_at = CASE
         WHEN started_at IS NULL AND $2 <> 'queued' THEN $6
         ELSE started_at END,
       completed_at = CASE WHEN $7 THEN $6 ELSE completed_at END
     WHERE id = $1 AND status NOT IN ('done', 'failed')
     RETURNING ${JOB_COLS_BASE}`,
    [
      event.jobId,
      event.status,
      event.progress,
      event.message ?? null,
      event.error ?? null,
      now,
      terminal,
      event.strategy ?? null,
    ],
  );
  if (!rows[0]) return null;

  // The UPDATE is the idempotency gate: a redelivered stream entry finds the job
  // already terminal, returns no row, and never gets here to duplicate artifacts.
  if (event.artifacts?.length) {
    const values: unknown[] = [];
    const tuples = event.artifacts.map((artifact, index) => {
      const base = index * 8;
      values.push(
        nanoid(16),
        event.jobId,
        artifact.kind,
        artifact.label,
        artifact.path,
        artifact.mimeType ?? null,
        JSON.stringify(artifact.meta ?? {}),
        now,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8})`;
    });
    await pool.query(
      `INSERT INTO job_artifacts
         (id, job_id, kind, label, storage_path, mime_type, meta, created_at)
       VALUES ${tuples.join(", ")}`,
      values,
    );
  }

  return getJob(event.jobId);
}

export async function listRoomMediaWithJobs(roomId: string): Promise<MediaItemWithJob[]> {
  const { rows } = await pool.query<MediaItemRow & Record<string, unknown>>(
    `SELECT m.*, p.display_name AS uploader_name,
            j.id AS j_id, j.media_item_id AS j_media_item_id, j.media_type AS j_media_type,
            j.strategy AS j_strategy, j.status AS j_status, j.progress AS j_progress,
            j.message AS j_message, j.artifacts AS j_artifacts,
            j.error AS j_error, j.attempt_count AS j_attempt_count,
            j.created_at AS j_created_at, j.started_at AS j_started_at,
            j.completed_at AS j_completed_at
     FROM media_items m
     JOIN participants p ON p.id = m.uploader_id
     LEFT JOIN LATERAL (
       SELECT e.*, ${artifactsJson("e")}
       FROM enhancement_jobs e
       WHERE e.media_item_id = m.id
       ORDER BY e.created_at DESC
       LIMIT 1
     ) j ON TRUE
     WHERE m.room_id = $1
     ORDER BY m.created_at ASC`,
    [roomId],
  );

  return rows.map((row) => {
    const mediaItem = toMediaItem(row as unknown as MediaItemRow);
    if (!row["j_id"]) return { mediaItem, job: null };
    const jobRow: JobRow = {
      id: row["j_id"] as string,
      media_item_id: row["j_media_item_id"] as string,
      media_type: row["j_media_type"] as MediaType,
      strategy: row["j_strategy"] as string,
      status: row["j_status"] as JobStatus,
      progress: row["j_progress"] as number,
      message: (row["j_message"] as string | null) ?? null,
      artifacts: (row["j_artifacts"] as ArtifactRow[] | null) ?? [],
      error: (row["j_error"] as string | null) ?? null,
      attempt_count: row["j_attempt_count"] as number,
      created_at: row["j_created_at"] as number,
      started_at: (row["j_started_at"] as number | null) ?? null,
      completed_at: (row["j_completed_at"] as number | null) ?? null,
    };
    return { mediaItem, job: toJob(jobRow) };
  });
}

// --- webhooks ---------------------------------------------------------------

interface WebhookEndpointRow {
  id: string;
  session_id: string;
  url: string;
  secret: string;
  active: boolean;
  created_at: number;
}

interface WebhookDeliveryRow {
  id: string;
  endpoint_id: string;
  event_type: string;
  attempt: number;
  status_code: number | null;
  error: string | null;
  latency_ms: number | null;
  delivered: boolean;
  terminal: boolean;
  created_at: number;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
}

/** A delivery joined with everything an attempt needs, so the dispatcher hits the DB once. */
export interface PendingWebhookDelivery {
  id: string;
  endpointId: string;
  eventType: string;
  payload: WebhookEventPayload;
  attempt: number;
  terminal: boolean;
  delivered: boolean;
  url: string;
  secret: string;
  endpointActive: boolean;
}

const ENDPOINT_COLS = "id, session_id, url, secret, active, created_at";

const DELIVERY_COLS =
  "id, endpoint_id, event_type, attempt, status_code, error, latency_ms, delivered, terminal, created_at, last_attempt_at, next_attempt_at";

const toEndpoint = (row: WebhookEndpointRow, withSecret = false): WebhookEndpoint => ({
  id: row.id,
  sessionId: row.session_id,
  url: row.url,
  active: row.active,
  createdAt: row.created_at,
  ...(withSecret ? { secret: row.secret } : {}),
});

const toDelivery = (row: WebhookDeliveryRow): WebhookDelivery => ({
  id: row.id,
  endpointId: row.endpoint_id,
  eventType: row.event_type,
  attempt: row.attempt,
  statusCode: row.status_code,
  error: row.error,
  latencyMs: row.latency_ms,
  delivered: row.delivered,
  terminal: row.terminal,
  createdAt: row.created_at,
  lastAttemptAt: row.last_attempt_at,
  nextAttemptAt: row.next_attempt_at,
});

export async function createWebhookEndpoint(input: {
  sessionId: string;
  url: string;
  secret: string;
}): Promise<WebhookEndpoint> {
  const { rows } = await pool.query<WebhookEndpointRow>(
    `INSERT INTO webhook_endpoints (id, session_id, url, secret, active, created_at)
     VALUES ($1, $2, $3, $4, TRUE, $5)
     RETURNING ${ENDPOINT_COLS}`,
    [nanoid(16), input.sessionId, input.url, input.secret, Date.now()],
  );
  return toEndpoint(rows[0]!, true);
}

export async function listWebhookEndpoints(sessionId: string): Promise<WebhookEndpoint[]> {
  const { rows } = await pool.query<WebhookEndpointRow>(
    `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows.map((row) => toEndpoint(row));
}

export async function listActiveWebhookEndpoints(sessionId: string): Promise<WebhookEndpoint[]> {
  const { rows } = await pool.query<WebhookEndpointRow>(
    `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints
     WHERE session_id = $1 AND active = TRUE
     ORDER BY created_at ASC`,
    [sessionId],
  );
  return rows.map((row) => toEndpoint(row, true));
}

export async function getWebhookEndpoint(id: string): Promise<WebhookEndpoint | null> {
  const { rows } = await pool.query<WebhookEndpointRow>(
    `SELECT ${ENDPOINT_COLS} FROM webhook_endpoints WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  return row ? toEndpoint(row) : null;
}

export async function deactivateWebhookEndpoint(id: string): Promise<WebhookEndpoint | null> {
  const { rows } = await pool.query<WebhookEndpointRow>(
    `UPDATE webhook_endpoints SET active = FALSE WHERE id = $1 RETURNING ${ENDPOINT_COLS}`,
    [id],
  );
  const row = rows[0];
  return row ? toEndpoint(row) : null;
}

export async function createWebhookDelivery(input: {
  endpointId: string;
  eventId: string;
  eventType: string;
  payload: WebhookEventPayload;
  dueAt: number;
}): Promise<WebhookDelivery> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `INSERT INTO webhook_deliveries
       (id, endpoint_id, event_id, event_type, payload, attempt, delivered, terminal, created_at, next_attempt_at)
     VALUES ($1, $2, $3, $4, $5, 0, FALSE, FALSE, $6, $7)
     RETURNING ${DELIVERY_COLS}`,
    [
      nanoid(16),
      input.endpointId,
      input.eventId,
      input.eventType,
      JSON.stringify(input.payload),
      Date.now(),
      input.dueAt,
    ],
  );
  return toDelivery(rows[0]!);
}

export async function getPendingWebhookDelivery(
  id: string,
): Promise<PendingWebhookDelivery | null> {
  const { rows } = await pool.query<{
    id: string;
    endpoint_id: string;
    event_type: string;
    payload: WebhookEventPayload;
    attempt: number;
    terminal: boolean;
    delivered: boolean;
    url: string;
    secret: string;
    endpoint_active: boolean;
  }>(
    `SELECT d.id, d.endpoint_id, d.event_type, d.payload, d.attempt, d.terminal, d.delivered,
            e.url, e.secret, e.active AS endpoint_active
     FROM webhook_deliveries d
     JOIN webhook_endpoints e ON e.id = d.endpoint_id
     WHERE d.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    endpointId: row.endpoint_id,
    eventType: row.event_type,
    payload: row.payload,
    attempt: row.attempt,
    terminal: row.terminal,
    delivered: row.delivered,
    url: row.url,
    secret: row.secret,
    endpointActive: row.endpoint_active,
  };
}

export async function recordWebhookAttempt(input: {
  id: string;
  attempt: number;
  statusCode: number | null;
  error: string | null;
  latencyMs: number | null;
  delivered: boolean;
  terminal: boolean;
  nextAttemptAt: number | null;
}): Promise<WebhookDelivery | null> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `UPDATE webhook_deliveries SET
       attempt = $2,
       status_code = $3,
       error = $4,
       latency_ms = $5,
       delivered = $6,
       terminal = $7,
       next_attempt_at = $8,
       last_attempt_at = $9
     WHERE id = $1
     RETURNING ${DELIVERY_COLS}`,
    [
      input.id,
      input.attempt,
      input.statusCode,
      input.error,
      input.latencyMs,
      input.delivered,
      input.terminal,
      input.nextAttemptAt,
      Date.now(),
    ],
  );
  const row = rows[0];
  return row ? toDelivery(row) : null;
}

export async function listWebhookDeliveries(
  endpointId: string,
  limit: number,
): Promise<WebhookDelivery[]> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `SELECT ${DELIVERY_COLS} FROM webhook_deliveries
     WHERE endpoint_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [endpointId, limit],
  );
  return rows.map(toDelivery);
}

/**
 * Clones a delivery's payload into a fresh row so the failed attempt history
 * stays readable next to the replay.
 */
export async function replayWebhookDelivery(id: string): Promise<WebhookDelivery | null> {
  const { rows } = await pool.query<WebhookDeliveryRow>(
    `INSERT INTO webhook_deliveries
       (id, endpoint_id, event_id, event_type, payload, attempt, delivered, terminal, created_at, next_attempt_at)
     SELECT $2, endpoint_id, event_id, event_type, payload, 0, FALSE, FALSE, $3, $3
     FROM webhook_deliveries WHERE id = $1
     RETURNING ${DELIVERY_COLS}`,
    [id, nanoid(16), Date.now()],
  );
  const row = rows[0];
  return row ? toDelivery(row) : null;
}
