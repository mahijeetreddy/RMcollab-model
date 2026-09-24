import type { Metrics } from "../features/cluster/ClusterPanel";
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
  ServerEvent,
  Session,
  StrategyDescriptor,
} from "@rmcollab/shared";

export type Guard<T> = (value: unknown) => value is T;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const isString: Guard<string> = (value): value is string => typeof value === "string";
const isNumber: Guard<number> = (value): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isBoolean: Guard<boolean> = (value): value is boolean => typeof value === "boolean";

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value): value is T | null => value === null || guard(value);
}

/** Absent keys arrive as `undefined`: JSON cannot carry the value itself. */
function optional<T>(guard: Guard<T>): Guard<T | undefined> {
  return (value): value is T | undefined => value === undefined || guard(value);
}

export function arrayOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value): value is T[] => Array.isArray(value) && value.every((entry) => guard(entry));
}

function literal<T extends string>(...allowed: readonly T[]): Guard<T> {
  return (value): value is T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const isNullableString = nullable(isString);
const isNullableNumber = nullable(isNumber);
const isOptionalString = optional(isString);

const isMediaType = literal<MediaType>("text", "image", "audio", "video");
const isJobStatus = literal<JobStatus>("queued", "processing", "done", "failed");

export const isSession: Guard<Session> = (value): value is Session =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["code"]) &&
  isNullableString(value["name"]) &&
  isNumber(value["createdAt"]);

export const isRoom: Guard<Room> = (value): value is Room =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["sessionId"]) &&
  isString(value["name"]) &&
  isBoolean(value["isMain"]) &&
  isBoolean(value["isLocked"]) &&
  isNullableString(value["ownerId"]) &&
  isNumber(value["createdAt"]);

const isParticipant: Guard<Participant> = (value): value is Participant =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["sessionId"]) &&
  isString(value["displayName"]) &&
  isNullableString(value["currentRoomId"]) &&
  isBoolean(value["connected"]) &&
  isNumber(value["joinedAt"]);

const isChatMessage: Guard<ChatMessage> = (value): value is ChatMessage =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["roomId"]) &&
  isString(value["participantId"]) &&
  isString(value["displayName"]) &&
  isString(value["body"]) &&
  isNumber(value["createdAt"]);

const isMediaItem: Guard<MediaItem> = (value): value is MediaItem =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["roomId"]) &&
  isString(value["uploaderId"]) &&
  isString(value["uploaderName"]) &&
  isMediaType(value["mediaType"]) &&
  isNullableString(value["originalFilename"]) &&
  isString(value["originalUrl"]) &&
  isNullableString(value["mimeType"]) &&
  isNullableNumber(value["sizeBytes"]) &&
  isNumber(value["createdAt"]);

const isArtifactKind = literal<ArtifactKind>("enhanced", "transcript", "summary");

const isArtifact: Guard<Artifact> = (value): value is Artifact =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["jobId"]) &&
  isArtifactKind(value["kind"]) &&
  isString(value["label"]) &&
  isString(value["url"]) &&
  isNullableString(value["mimeType"]) &&
  isNullableNumber(value["sizeBytes"]) &&
  isRecord(value["meta"]) &&
  isNumber(value["createdAt"]);

const isArrayOfArtifacts = arrayOf(isArtifact);

const isEnhancementJob: Guard<EnhancementJob> = (value): value is EnhancementJob =>
  isRecord(value) &&
  isString(value["id"]) &&
  isString(value["mediaItemId"]) &&
  isMediaType(value["mediaType"]) &&
  isString(value["strategy"]) &&
  isJobStatus(value["status"]) &&
  isNumber(value["progress"]) &&
  isNullableString(value["message"]) &&
  isArrayOfArtifacts(value["artifacts"]) &&
  isNullableString(value["error"]) &&
  isNumber(value["attemptCount"]) &&
  isNumber(value["createdAt"]) &&
  isNullableNumber(value["startedAt"]) &&
  isNullableNumber(value["completedAt"]);

export const isMediaItemWithJob: Guard<MediaItemWithJob> = (value): value is MediaItemWithJob =>
  isRecord(value) &&
  isMediaItem(value["mediaItem"]) &&
  nullable(isEnhancementJob)(value["job"]);

export const isStrategyDescriptor: Guard<StrategyDescriptor> = (
  value,
): value is StrategyDescriptor =>
  isRecord(value) &&
  isMediaType(value["mediaType"]) &&
  isString(value["name"]) &&
  isString(value["label"]) &&
  isString(value["description"]) &&
  isBoolean(value["isDefault"]) &&
  isBoolean(value["available"]);

// Keyed by discriminant so a new ServerEvent variant fails to compile until a
// validator exists for it — the guard cannot silently fall behind the contract.
const eventGuards: { [K in ServerEvent["type"]]: (event: Fields) => boolean } = {
  session_joined: (e) =>
    isSession(e["session"]) && isParticipant(e["participant"]) && arrayOf(isRoom)(e["rooms"]),

  room_state: (e) =>
    isString(e["roomId"]) &&
    arrayOf(isParticipant)(e["participants"]) &&
    arrayOf(isChatMessage)(e["chatHistory"]) &&
    arrayOf(isMediaItemWithJob)(e["media"]),

  typing: (e) =>
    isString(e["roomId"]) &&
    isString(e["participantId"]) &&
    isString(e["displayName"]) &&
    isBoolean(e["isTyping"]),

  rooms_updated: (e) => isString(e["sessionId"]) && arrayOf(isRoom)(e["rooms"]),

  participant_joined: (e) => isString(e["roomId"]) && isParticipant(e["participant"]),

  participant_left: (e) => isString(e["roomId"]) && isString(e["participantId"]),

  chat_message: (e) => isString(e["roomId"]) && isChatMessage(e["message"]),

  media_uploaded: (e) =>
    isString(e["roomId"]) && isMediaItem(e["mediaItem"]) && isEnhancementJob(e["job"]),

  job_status_update: (e) =>
    isString(e["roomId"]) &&
    isString(e["jobId"]) &&
    isString(e["mediaItemId"]) &&
    literal("queued", "processing")(e["status"]) &&
    isNumber(e["progress"]) &&
    isOptionalString(e["message"]),

  job_complete: (e) =>
    isString(e["roomId"]) &&
    isString(e["jobId"]) &&
    isString(e["mediaItemId"]) &&
    literal("done", "failed")(e["status"]) &&
    isArrayOfArtifacts(e["artifacts"]) &&
    isOptionalString(e["error"]),

  pong: () => true,

  error: (e) => isString(e["code"]) && isString(e["message"]),
};

export function isServerEvent(value: unknown): value is ServerEvent {
  if (!isRecord(value)) return false;
  const type = value["type"];
  if (!isString(type) || !(type in eventGuards)) return false;
  return eventGuards[type as ServerEvent["type"]](value);
}

/** Enough to name the offender in a log line without dumping a whole frame. */
export function describeFrame(value: unknown): string {
  if (!isRecord(value)) return `a non-object frame (${typeof value})`;
  const type = value["type"];
  if (!isString(type)) return "a frame with no event type";
  if (!(type in eventGuards)) return `an unknown event type "${type}"`;
  return `a malformed "${type}" event`;
}

/** Shape of GET /api/metrics. Validated like every other gateway response so a
 *  drifted field surfaces as an error instead of NaN in the cluster table. */
export const isMetrics = (value: unknown): value is Metrics =>
  isRecord(value) &&
  isString(value["replicaId"]) &&
  Array.isArray(value["queues"]) &&
  value["queues"].every(
    (q) =>
      isRecord(q) &&
      isString(q["mediaType"]) &&
      isString(q["queue"]) &&
      isNumber(q["depth"]) &&
      isBoolean(q["workersOnline"]),
  ) &&
  isRecord(value["jobs"]) &&
  isNumber(value["jobEventStreamLength"]);
