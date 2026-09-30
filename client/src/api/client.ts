import type {
  LibraryEntry,
  MediaItemWithJob,
  MediaType,
  Room,
  Session,
  StrategyDescriptor, RoomDocument } from "@rmcollab/shared";
import type { Metrics } from "../features/cluster/ClusterPanel";
import {
  arrayOf,
  isLibraryEntry,
  isMediaItemWithJob,
  isRoom,
  isSession,
  isStrategyDescriptor,
  isString,
  type Guard,
  isMetrics,
} from "../lib/guards";

export const GATEWAY_HTTP: string =
  import.meta.env.VITE_GATEWAY_HTTP ?? "http://localhost:4000";

export const GATEWAY_WS: string =
  import.meta.env.VITE_GATEWAY_WS ?? "ws://localhost:4000/ws";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

/** Job `resultUrl` / media `originalUrl` may be absolute or storage-relative. */
export function resolveFileUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^(https?:|blob:|data:)/i.test(url)) return url;
  return `${GATEWAY_HTTP.replace(/\/$/, "")}/${url.replace(/^\//, "")}`;
}

async function readError(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  let code: string | null = null;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      if (typeof record["message"] === "string") message = record["message"];
      else if (typeof record["error"] === "string") message = record["error"];
      if (typeof record["code"] === "string") code = record["code"];
    }
  } catch {
    // Non-JSON error body; the status line is the best message available.
  }
  return new ApiError(response.status, message, code);
}

// Responses are validated, not asserted: a drifted or proxied-over gateway
// otherwise surfaces as an undefined-property crash somewhere in a component.
async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: unknown }> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_HTTP.replace(/\/$/, "")}${path}`, init);
  } catch {
    throw new ApiError(0, `Cannot reach gateway at ${GATEWAY_HTTP}`, "network_error");
  }
  if (!response.ok) throw await readError(response);

  try {
    return { status: response.status, body: await response.json() };
  } catch {
    throw new ApiError(response.status, "Gateway returned a non-JSON response", "invalid_response");
  }
}

const badShape = (status: number, path: string): ApiError =>
  new ApiError(
    status,
    `Gateway returned an unexpected response shape for ${path}`,
    "invalid_response",
  );

async function request<T>(path: string, guard: Guard<T>, init?: RequestInit): Promise<T> {
  const { status, body } = await fetchJson(path, init);
  if (!guard(body)) throw badShape(status, path);
  return body;
}

/**
 * The gateway wraps payloads in a named envelope (`{session, rooms}`, `{rooms}`,
 * `{room}`, `{strategies}`) so a response can carry more than one thing. Unwrap
 * the field and validate that, not the envelope.
 */
async function requestIn<T>(
  path: string,
  key: string,
  guard: Guard<T>,
  init?: RequestInit,
): Promise<T> {
  const { status, body } = await fetchJson(path, init);
  const value =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)[key]
      : undefined;
  if (!guard(value)) throw badShape(status, path);
  return value;
}

/** A request answered with no body (204), where only success matters. */
async function send(path: string, init: RequestInit): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_HTTP.replace(/\/$/, "")}${path}`, init);
  } catch {
    throw new ApiError(0, `Cannot reach gateway at ${GATEWAY_HTTP}`, "network_error");
  }
  if (!response.ok) throw await readError(response);
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const media = (roomId: string, mediaItemId: string) =>
  `/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(mediaItemId)}`;

export const api = {
  /** A session already holding analysed sample material, to try the app with. */
  createDemo(): Promise<Session> {
    return requestIn("/api/demo", "session", isSession, json({}));
  },

  async listDocuments(roomId: string, participantId: string): Promise<RoomDocument[]> {
    const { body } = await fetchJson(
      `/api/rooms/${encodeURIComponent(roomId)}/documents?participantId=${encodeURIComponent(participantId)}`,
    );
    return (body as { documents: RoomDocument[] }).documents;
  },

  async createDocument(roomId: string, participantId: string, title: string): Promise<RoomDocument> {
    const { body } = await fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/documents`, json({ participantId, title }));
    return (body as { document: RoomDocument }).document;
  },

  renameDocument(roomId: string, docId: string, participantId: string, title: string): Promise<unknown> {
    return fetchJson(`/api/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(docId)}`, {
      ...json({ participantId, title }),
      method: "PATCH",
    });
  },

  deleteDocument(roomId: string, docId: string, participantId: string): Promise<void> {
    return send(
      `/api/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(docId)}?participantId=${encodeURIComponent(participantId)}`,
      { method: "DELETE" },
    );
  },

  async listVersions(roomId: string, participantId: string, docId: string) {
    const { body } = await fetchJson(
      `/api/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(docId)}/versions?participantId=${encodeURIComponent(participantId)}`,
    );
    return (body as { versions: { id: string; createdAt: number; reason: string; words: number }[] }).versions;
  },

  async getVersion(roomId: string, participantId: string, docId: string, versionId: string) {
    const { body } = await fetchJson(
      `/api/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}?participantId=${encodeURIComponent(participantId)}`,
    );
    return body as {
      version: { id: string; createdAt: number; reason: string; words: number };
      sections: { title: string; text: string }[];
    };
  },

  restoreVersion(roomId: string, participantId: string, docId: string, versionId: string): Promise<unknown> {
    return fetchJson(
      `/api/rooms/${encodeURIComponent(roomId)}/documents/${encodeURIComponent(docId)}/versions/${encodeURIComponent(versionId)}/restore`,
      json({ participantId }),
    );
  },

  renameMedia(roomId: string, mediaItemId: string, participantId: string, title: string): Promise<unknown> {
    return fetchJson(media(roomId, mediaItemId), { ...json({ participantId, title }), method: "PATCH" });
  },

  retryMedia(roomId: string, mediaItemId: string, participantId: string): Promise<unknown> {
    return fetchJson(`${media(roomId, mediaItemId)}/retry`, json({ participantId }));
  },

  deleteMedia(roomId: string, mediaItemId: string, participantId: string): Promise<void> {
    return send(`${media(roomId, mediaItemId)}?participantId=${encodeURIComponent(participantId)}`, { method: "DELETE" });
  },

  /** Resolves with the session's new code when the removal was from the whole session. */
  async removeParticipant(roomId: string, targetId: string, participantId: string): Promise<string | null> {
    const response = await fetch(
      `${GATEWAY_HTTP.replace(/\/$/, "")}/api/rooms/${encodeURIComponent(roomId)}/participants/${encodeURIComponent(targetId)}/remove`,
      json({ participantId }),
    ).catch(() => {
      throw new ApiError(0, `Cannot reach gateway at ${GATEWAY_HTTP}`, "network_error");
    });
    if (!response.ok) throw await readError(response);
    if (response.status === 204) return null;
    const body = (await response.json().catch(() => ({}))) as { newCode?: unknown };
    return typeof body.newCode === "string" ? body.newCode : null;
  },

  deleteRoom(roomId: string, participantId: string): Promise<void> {
    return send(`/api/rooms/${encodeURIComponent(roomId)}?participantId=${encodeURIComponent(participantId)}`, {
      method: "DELETE",
    });
  },

  createSession(name?: string): Promise<Session> {
    return requestIn("/api/sessions", "session", isSession, json(name ? { name } : {}));
  },

  getSession(code: string, participantId?: string): Promise<Session> {
    const who = participantId ? `?participantId=${encodeURIComponent(participantId)}` : "";
    return requestIn(`/api/sessions/${encodeURIComponent(code)}${who}`, "session", isSession);
  },

  setWaitingRoom(code: string, participantId: string, waitingRoom: boolean): Promise<unknown> {
    return fetchJson(`/api/sessions/${encodeURIComponent(code)}`, { ...json({ participantId, waitingRoom }), method: "PATCH" });
  },

  async waitingList(code: string, participantId: string): Promise<{ id: string; displayName: string }[]> {
    const { body } = await fetchJson(
      `/api/sessions/${encodeURIComponent(code)}/waiting?participantId=${encodeURIComponent(participantId)}`,
    );
    return (body as { waiting: { id: string; displayName: string }[] }).waiting;
  },

  decideAdmission(code: string, participantId: string, targetId: string, admit: boolean): Promise<void> {
    return send(`/api/sessions/${encodeURIComponent(code)}/admissions`, json({ participantId, targetId, admit }));
  },

  listRooms(code: string): Promise<Room[]> {
    return requestIn(`/api/sessions/${encodeURIComponent(code)}/rooms`, "rooms", arrayOf(isRoom));
  },

  createRoom(
    code: string,
    name: string,
    participantId: string | null,
    accessCode?: string,
  ): Promise<Room> {
    return requestIn(
      `/api/sessions/${encodeURIComponent(code)}/rooms`,
      "room",
      isRoom,
      json({
        name,
        ...(accessCode ? { accessCode } : {}),
        ...(participantId ? { participantId } : {}),
      }),
    );
  },

  /** Owner-only; rejects with 403 for anyone else. */
  roomCode(roomId: string, participantId: string): Promise<string> {
    return requestIn(
      `/api/rooms/${encodeURIComponent(roomId)}/code?participantId=${encodeURIComponent(participantId)}`,
      "code",
      isString,
    );
  },

  /** A room's documents, newest first, or ranked matches when `query` is set. */
  library(
    roomId: string,
    participantId: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<LibraryEntry[]> {
    const params = new URLSearchParams({ participantId });
    if (query.trim()) params.set("q", query.trim());
    return requestIn(
      `/api/rooms/${encodeURIComponent(roomId)}/library?${params}`,
      "entries",
      arrayOf(isLibraryEntry),
      signal ? { signal } : undefined,
    );
  },

  metrics(): Promise<Metrics> {
    return request("/api/metrics", isMetrics);
  },

  listStrategies(): Promise<StrategyDescriptor[]> {
    return requestIn("/api/strategies", "strategies", arrayOf(isStrategyDescriptor));
  },

  uploadText(
    roomId: string,
    participantId: string,
    text: string,
    strategy: string,
  ): Promise<MediaItemWithJob> {
    const mediaType: MediaType = "text";
    return request(
      `/api/rooms/${encodeURIComponent(roomId)}/media`,
      isMediaItemWithJob,
      json({ participantId, mediaType, text, strategy }),
    );
  },

  uploadFile(
    roomId: string,
    participantId: string,
    file: File,
    strategy: string,
  ): Promise<MediaItemWithJob> {
    const form = new FormData();
    form.append("file", file);
    form.append("participantId", participantId);
    form.append("strategy", strategy);
    return request(`/api/rooms/${encodeURIComponent(roomId)}/media`, isMediaItemWithJob, {
      method: "POST",
      body: form,
    });
  },

  async fetchTextBlob(url: string): Promise<string> {
    const response = await fetch(url);
    if (!response.ok) throw await readError(response);
    return response.text();
  },
};
