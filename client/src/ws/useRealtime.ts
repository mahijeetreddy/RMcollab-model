import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ClientEvent, ServerEvent } from "@rmcollab/shared";
import { GATEWAY_WS } from "../api/client";
import { describeFrame, isServerEvent } from "../lib/guards";
import { initialRoomState, roomReducer, type RoomState } from "../state/roomReducer";

export type ConnectionStatus = "connecting" | "online" | "reconnecting" | "offline";

export interface Credentials {
  sessionCode: string;
  displayName: string;
}

export interface Realtime {
  state: RoomState;
  status: ConnectionStatus;
  /** Reconnect attempts since the last successful open; 0 while healthy. */
  attempt: number;
  joinRoom: (roomId: string, code?: string) => void;
  sendTyping: (isTyping: boolean) => void;
  sendChat: (body: string) => boolean;
  reconnectNow: () => void;
  clearError: () => void;
}

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const MAX_ATTEMPTS = 10;
const TYPING_PING_MS = 2_000;
// Comfortably longer than the ping interval, so a steady typist never flickers.
const TYPING_TTL_MS = 5_000;
const HEARTBEAT_MS = 20_000;
const PONG_GRACE_MS = 50_000;

function backoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt);
  return exponential * (0.75 + Math.random() * 0.5);
}

type Frame = { ok: true; event: ServerEvent } | { ok: false; reason: string };

// The gateway is a separate process and `ServerEvent` is erased at runtime, so
// every frame is validated before it can reach the reducer. A bad frame is
// dropped rather than tearing down an otherwise healthy socket.
function parseServerEvent(data: unknown): Frame {
  if (typeof data !== "string") return { ok: false, reason: "a binary frame" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { ok: false, reason: "a frame that was not valid JSON" };
  }
  if (!isServerEvent(parsed)) return { ok: false, reason: describeFrame(parsed) };
  return { ok: true, event: parsed };
}

export function useRealtime(credentials: Credentials | null): Realtime {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [status, setStatus] = useState<ConnectionStatus>("offline");
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<number | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const lastPongRef = useRef(0);
  const teardownRef = useRef(false);
  const openRef = useRef<(() => void) | null>(null);

  // Survive reconnects: the room we want to be in, and the identity the gateway
  // gave us, are replayed on every fresh socket.
  const desiredRoomIdRef = useRef<string | null>(null);
  const participantIdRef = useRef<string | undefined>(undefined);

  const sessionCode = credentials?.sessionCode ?? null;
  const displayName = credentials?.displayName ?? null;

  const send = useCallback((event: ClientEvent): boolean => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(event));
    return true;
  }, []);

  useEffect(() => {
    if (!sessionCode || !displayName) {
      setStatus("offline");
      return;
    }

    teardownRef.current = false;
    attemptRef.current = 0;
    setAttempt(0);

    const clearTimers = () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (heartbeatTimerRef.current !== null) {
        window.clearInterval(heartbeatTimerRef.current);
        heartbeatTimerRef.current = null;
      }
    };

    const startHeartbeat = (socket: WebSocket) => {
      lastPongRef.current = Date.now();
      heartbeatTimerRef.current = window.setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        // A socket can stay OPEN across a dead path; missing pongs are the only
        // reliable signal, so force a close and let the backoff loop resync.
        if (Date.now() - lastPongRef.current > PONG_GRACE_MS) {
          socket.close(4000, "heartbeat timeout");
          return;
        }
        socket.send(JSON.stringify({ type: "ping" } satisfies ClientEvent));
      }, HEARTBEAT_MS);
    };

    const scheduleReconnect = () => {
      if (teardownRef.current) return;
      if (attemptRef.current >= MAX_ATTEMPTS) {
        setStatus("offline");
        return;
      }
      const delay = backoffDelay(attemptRef.current);
      attemptRef.current += 1;
      setAttempt(attemptRef.current);
      setStatus("reconnecting");
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        open();
      }, delay);
    };

    const open = () => {
      if (teardownRef.current) return;
      clearTimers();

      const stale = socketRef.current;
      if (stale) {
        socketRef.current = null;
        stale.onopen = null;
        stale.onmessage = null;
        stale.onerror = null;
        stale.onclose = null;
        stale.close(1000, "superseded");
      }

      setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const socket = new WebSocket(GATEWAY_WS);
      socketRef.current = socket;

      socket.onopen = () => {
        if (teardownRef.current) {
          socket.close();
          return;
        }
        attemptRef.current = 0;
        setAttempt(0);
        setStatus("online");
        // Resync handshake: re-declare identity, then re-enter the room. The
        // gateway answers with session_joined + a full room_state snapshot,
        // which replaces local state — nothing missed while offline is merged.
        socket.send(
          JSON.stringify({
            type: "join_session",
            sessionCode,
            displayName,
            ...(participantIdRef.current ? { participantId: participantIdRef.current } : {}),
          } satisfies ClientEvent),
        );
        const roomId = desiredRoomIdRef.current;
        if (roomId) {
          socket.send(JSON.stringify({ type: "join_room", roomId } satisfies ClientEvent));
        }
        startHeartbeat(socket);
      };

      socket.onmessage = (message: MessageEvent<unknown>) => {
        const frame = parseServerEvent(message.data);
        if (!frame.ok) {
          console.warn(`[realtime] discarded ${frame.reason}`);
          dispatch({
            type: "invalid_event",
            reason: `The gateway sent ${frame.reason}; it was ignored.`,
          });
          return;
        }
        const event = frame.event;

        if (event.type === "pong") {
          lastPongRef.current = Date.now();
          return;
        }

        if (event.type === "session_joined") {
          participantIdRef.current = event.participant.id;
          dispatch({ type: "server_event", event });
          // First connection of a session: land in the main room automatically.
          if (!desiredRoomIdRef.current) {
            const target = event.rooms.find((room) => room.isMain) ?? event.rooms[0];
            if (target) {
              desiredRoomIdRef.current = target.id;
              dispatch({ type: "room_requested", roomId: target.id });
              socket.send(
                JSON.stringify({ type: "join_room", roomId: target.id } satisfies ClientEvent),
              );
            }
          }
          return;
        }

        dispatch({ type: "server_event", event });
      };

      socket.onerror = () => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
      };

      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        clearTimers();
        if (teardownRef.current) return;
        dispatch({ type: "connection_lost" });
        scheduleReconnect();
      };
    };

    openRef.current = () => {
      attemptRef.current = 0;
      setAttempt(0);
      open();
    };
    open();

    return () => {
      teardownRef.current = true;
      openRef.current = null;
      clearTimers();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close(1000, "client teardown");
      }
      desiredRoomIdRef.current = null;
      participantIdRef.current = undefined;
      dispatch({ type: "reset" });
      setStatus("offline");
    };
  }, [sessionCode, displayName]);

  const joinRoom = useCallback(
    (roomId: string, code?: string) => {
      // A retry with a code must go through even when the room is already the
      // desired one: the previous attempt was refused for lacking it.
      if (desiredRoomIdRef.current === roomId && !code) return;
      desiredRoomIdRef.current = roomId;
      dispatch({ type: "room_requested", roomId });
      // If the socket is down, the join replays on the next successful open.
      send(code ? { type: "join_room", roomId, code } : { type: "join_room", roomId });
    },
    [send],
  );

  // Coalesced: one "still typing" ping at most every TYPING_PING_MS while keys
  // are going in, and an immediate "stopped" so the indicator clears crisply.
  const lastTypingPingRef = useRef(0);
  const sendTyping = useCallback(
    (isTyping: boolean) => {
      const roomId = desiredRoomIdRef.current;
      if (!roomId) return;
      const now = Date.now();
      if (isTyping) {
        if (now - lastTypingPingRef.current < TYPING_PING_MS) return;
        lastTypingPingRef.current = now;
      } else {
        lastTypingPingRef.current = 0;
      }
      send({ type: "typing", roomId, isTyping });
    },
    [send],
  );

  // Expire indicators whose sender went quiet without telling us.
  useEffect(() => {
    const timer = setInterval(
      () => dispatch({ type: "prune_typing", olderThan: Date.now() - TYPING_TTL_MS }),
      1000,
    );
    return () => clearInterval(timer);
  }, []);

  const sendChat = useCallback(
    (body: string): boolean => {
      const roomId = desiredRoomIdRef.current;
      const trimmed = body.trim();
      if (!roomId || !trimmed) return false;
      return send({ type: "chat_message", roomId, body: trimmed });
    },
    [send],
  );

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) return;
    openRef.current?.();
  }, []);

  const clearError = useCallback(() => dispatch({ type: "clear_error" }), []);

  return useMemo(
    () => ({ state, status, attempt, joinRoom, sendChat, sendTyping, reconnectNow, clearError }),
    [state, status, attempt, joinRoom, sendChat, sendTyping, reconnectNow, clearError],
  );
}
