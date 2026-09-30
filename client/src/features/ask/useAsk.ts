import { useCallback, useEffect, useRef, useState } from "react";
import type { AskFallback, AskSource } from "@rmcollab/shared";
import type { Realtime } from "../../ws/useRealtime";

export type AskStatus = "searching" | "answering" | "done";

export interface AskTurn {
  requestId: string;
  question: string;
  status: AskStatus;
  sources: AskSource[];
  text: string;
  cited: number[];
  fallback: AskFallback | null;
  noEvidence: boolean;
  model: string | null;
  /** How a follow-up was understood, when that differs from what was typed. */
  standalone: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** How long before a question with no reply at all is given up on here. */
const GIVE_UP_MS = 100_000;

function newRequestId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * This person's questions about the current room and their answers, oldest
 * first, as a conversation reads. Held above the views, so an answer keeps
 * arriving while its asker follows a citation into the feed or the notes.
 * Private: nothing here is shared with the room unless they add it to the notes.
 */
export function useAsk(realtime: Realtime, roomId: string | null) {
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const roomRef = useRef(roomId);

  // A different room is a different conversation.
  useEffect(() => {
    if (roomRef.current !== roomId) setTurns([]);
    roomRef.current = roomId;
  }, [roomId]);

  const { subscribeAsk, sendAsk } = realtime;
  useEffect(
    () =>
      subscribeAsk((event) => {
        setTurns((current) =>
          current.map((turn) => {
            if (turn.requestId !== event.requestId) return turn;
            switch (event.type) {
              case "ask_sources":
                return { ...turn, sources: event.sources, standalone: event.standalone ?? null, status: "answering" };
              case "ask_delta":
                return { ...turn, text: turn.text + event.text, status: "answering" };
              case "ask_done":
                return {
                  ...turn,
                  status: "done",
                  cited: event.cited,
                  fallback: event.fallback ?? null,
                  noEvidence: event.noEvidence ?? false,
                  model: event.model ?? null,
                  finishedAt: Date.now(),
                };
            }
          }),
        );
      }),
    [subscribeAsk],
  );

  // A reply that never comes (the socket dropped mid-answer) must not leave a
  // question spinning for ever.
  useEffect(() => {
    if (!turns.some((turn) => turn.status !== "done")) return;
    const timer = window.setInterval(() => {
      setTurns((current) =>
        current.map((turn) =>
          turn.status !== "done" && Date.now() - turn.startedAt > GIVE_UP_MS
            ? { ...turn, status: "done", fallback: "timeout", finishedAt: Date.now() }
            : turn,
        ),
      );
    }, 5000);
    return () => window.clearInterval(timer);
  }, [turns]);

  const ask = useCallback(
    (question: string): boolean => {
      const trimmed = question.trim();
      if (!roomId || trimmed.length < 2) return false;
      const requestId = newRequestId();
      // The last few answered turns, so "and who owns that?" can be understood.
      // Citation markers and failed turns carry nothing a follow-up needs.
      const history = turnsRef.current
        .filter((turn) => turn.status === "done" && turn.text && !turn.fallback)
        .slice(-3)
        .map((turn) => ({
          question: turn.question,
          answer: turn.text.replace(/\s*\[\d{1,2}\]/g, "").slice(0, 1500),
        }));
      if (!sendAsk(roomId, requestId, trimmed, history)) return false;
      setTurns((current) => [
        ...current,
        {
          requestId,
          question: trimmed,
          status: "searching",
          sources: [],
          text: "",
          cited: [],
          fallback: null,
          noEvidence: false,
          model: null,
          standalone: null,
          startedAt: Date.now(),
          finishedAt: null,
        },
      ]);
      return true;
    },
    [roomId, sendAsk],
  );

  const clear = useCallback(() => setTurns([]), []);
  return { turns, ask, clear };
}

export type AskState = ReturnType<typeof useAsk>;
