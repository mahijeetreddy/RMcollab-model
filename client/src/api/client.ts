import type {
  MediaItemWithJob,
  MediaType,
  Room,
  Session,
  StrategyDescriptor,
} from "@rmcollab/shared";
import type { Metrics } from "../features/cluster/ClusterPanel";
import {
  arrayOf,
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

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const api = {
  createSession(name?: string): Promise<Session> {
    return requestIn("/api/sessions", "session", isSession, json(name ? { name } : {}));
  },

  getSession(code: string): Promise<Session> {
    return requestIn(`/api/sessions/${encodeURIComponent(code)}`, "session", isSession);
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
