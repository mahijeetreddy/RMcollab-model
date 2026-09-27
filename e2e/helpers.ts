import { readFile } from "node:fs/promises";
import WebSocket from "ws";

export const API = (process.env.API_URL ?? "http://localhost:4000").replace(/\/$/, "");
export const WS = `${API.replace(/^http/, "ws")}/ws`;

export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

export async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status}`);
  return (await response.json()) as T;
}

export interface CreatedSession {
  session: { id: string; code: string };
  rooms: { id: string; name: string; isMain: boolean }[];
}

export function createSession(name = "e2e"): Promise<CreatedSession> {
  return json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** A participant connected over the real WebSocket, recording every frame. */
export class Participant {
  readonly events: ServerEvent[] = [];
  id = "";
  private constructor(private readonly socket: WebSocket) {}

  static async join(sessionCode: string, displayName: string): Promise<Participant> {
    const socket = new WebSocket(WS);
    const participant = new Participant(socket);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      participant.events.push(event);
      if (event.type === "session_joined") {
        participant.id = (event.participant as { id: string }).id;
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    participant.send({ type: "join_session", sessionCode, displayName });
    await participant.waitFor((e) => e.type === "room_state");
    return participant;
  }

  send(event: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(event));
  }

  /** Resolves with the first event (recorded or future) matching `predicate`. */
  async waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs = 30_000): Promise<ServerEvent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.events.find(predicate);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    const seen = [...new Set(this.events.map((e) => e.type))].join(", ");
    throw new Error(`timed out waiting for event; saw: ${seen}`);
  }

  close(): void {
    this.socket.close();
  }
}

export async function uploadText(roomId: string, participantId: string, text: string, strategy: string) {
  return json<{ job: { id: string } }>(`/api/rooms/${roomId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ participantId, mediaType: "text", text, strategy }),
  });
}

export async function uploadFile(
  roomId: string,
  participantId: string,
  fixture: string,
  mime: string,
  strategy?: string,
) {
  const bytes = await readFile(new URL(`./fixtures/${fixture}`, import.meta.url));
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), fixture);
  form.append("participantId", participantId);
  if (strategy) form.append("strategy", strategy);
  const response = await fetch(`${API}/api/rooms/${roomId}/media`, { method: "POST", body: form });
  if (!response.ok) throw new Error(`upload ${fixture} -> ${response.status}`);
  return (await response.json()) as { job: { id: string } };
}

/**
 * A strategy registered by a worker that has just started is only selectable once
 * the gateway's advertisement cache refreshes (every 15s). Tests that name a
 * strategy wait for it rather than silently getting the fallback.
 */
export async function waitForStrategy(mediaType: string, name: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { strategies } = await json<{ strategies: { mediaType: string; name: string }[] }>(
      "/api/strategies",
    );
    if (strategies.some((s) => s.mediaType === mediaType && s.name === name)) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`strategy ${mediaType}/${name} was never advertised`);
}
