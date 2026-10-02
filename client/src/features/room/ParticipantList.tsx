import { useEffect, useRef, useState } from "react";
import type { Participant, Room } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { NewCodeNotice } from "./Admission";
import { initials } from "../../lib/format";

interface Props {
  participants: Participant[];
  meId: string | null;
  /** The active room's owner: its creator, or for the main room the session's first person. */
  ownerId: string | null;
  room?: Room | null;
  /** For handing the session over; only the main room's owner is offered it. */
  sessionCode?: string | null;
}

export function ParticipantList({ participants, meId, ownerId, room = null, sessionCode = null }: Props) {
  const iOwnIt = Boolean(meId && ownerId && meId === ownerId && room);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [handingTo, setHandingTo] = useState<string | null>(null);
  const handOver = async (target: Participant) => {
    if (!sessionCode || !meId) return;
    setBusy(true);
    setError(null);
    try {
      await api.handOverSession(sessionCode, meId, target.id);
      setHandingTo(null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : `Could not hand the session to ${target.displayName}.`);
    } finally {
      setBusy(false);
    }
  };
  const [newCode, setNewCode] = useState<{ code: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (target: Participant) => {
    if (!room || !meId) return;
    setBusy(true);
    setError(null);
    try {
      const newCode = await api.removeParticipant(room.id, target.id, meId);
      setConfirming(null);
      if (newCode) setNewCode({ code: newCode, name: target.displayName });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : `Could not remove ${target.displayName}.`);
    } finally {
      setBusy(false);
    }
  };
  const ordered = [...participants].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });

  // Announce arrivals and departures only — never the whole roster on every
  // render, which would make the live region unusable.
  const knownRef = useRef<Map<string, boolean> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const next = new Map(participants.map((p) => [p.id, p.connected]));
    const previous = knownRef.current;
    knownRef.current = next;
    if (!previous) return;

    const changes: string[] = [];
    for (const participant of participants) {
      const before = previous.get(participant.id);
      if (before === undefined && participant.connected) {
        changes.push(`${participant.displayName} joined the room`);
      } else if (before === true && !participant.connected) {
        changes.push(`${participant.displayName} disconnected`);
      } else if (before === false && participant.connected) {
        changes.push(`${participant.displayName} reconnected`);
      }
    }
    if (changes.length > 0) setAnnouncement(changes.join(". "));
  }, [participants]);

  return (
    <section aria-labelledby="participants-heading">
      <h2 className="section-title" id="participants-heading">
        <span>In this room</span>
        <span className="count-pill">{participants.length}</span>
      </h2>

      <p className="visually-hidden" aria-live="polite">
        {announcement}
      </p>
      {confirming && room && (() => {
        const target = participants.find((p) => p.id === confirming);
        if (!target) return null;
        return (
          <div
            className="room-delete-confirm participant-confirm"
            role="alertdialog"
            aria-label={`Remove ${target.displayName}?`}
            onKeyDown={(event) => event.key === "Escape" && !busy && setConfirming(null)}
          >
            <p>
              {room.isMain ? (
                <>
                  Remove <strong>{target.displayName}</strong> from the session? They are disconnected, and the session
                  gets a new code, so the one they know stops working.
                </>
              ) : (
                <>
                  Remove <strong>{target.displayName}</strong> from <strong>{room.name}</strong>? They move to the main room
                  and can't come back into this one.
                </>
              )}
            </p>
            <div className="job-confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirming(null)} disabled={busy} autoFocus>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void remove(target)} disabled={busy}>
                {busy ? "Removing…" : "Remove"}
              </button>
            </div>
          </div>
        );
      })()}
      {handingTo && room?.isMain && (() => {
        const target = participants.find((p) => p.id === handingTo);
        if (!target) return null;
        return (
          <div
            className="room-delete-confirm participant-confirm"
            role="alertdialog"
            aria-label={`Make ${target.displayName} the owner?`}
            onKeyDown={(event) => event.key === "Escape" && !busy && setHandingTo(null)}
          >
            <p>
              Make <strong>{target.displayName}</strong> the session's owner? They get the owner's controls (the waiting
              room, removing people, ending the session), and you become an ordinary member.
            </p>
            <div className="job-confirm-actions">
              <button type="button" className="ghost" onClick={() => setHandingTo(null)} disabled={busy} autoFocus>
                Cancel
              </button>
              <button type="button" className="primary" onClick={() => void handOver(target)} disabled={busy}>
                {busy ? "Handing over…" : "Make owner"}
              </button>
            </div>
          </div>
        );
      })()}
      {newCode && <NewCodeNotice code={newCode.code} name={newCode.name} onClose={() => setNewCode(null)} />}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="empty">Nobody here yet</p>
      ) : (
        <ul className="participants">
          {ordered.map((participant) => (
            <li key={participant.id}>
              <span
                className={participant.connected ? "avatar" : "avatar is-away"}
                aria-hidden="true"
              >
                {initials(participant.displayName)}
              </span>
              <span className="participant-name">{participant.displayName}</span>
              {participant.id === ownerId && (
                <span className="owner-crown" title="Room owner">
                  <span aria-hidden="true">👑</span>
                  <span className="visually-hidden">room owner</span>
                </span>
              )}
              {participant.id === meId && <span className="you-tag">you</span>}
              {iOwnIt && participant.id !== meId && (
                <button
                  type="button"
                  className="ghost participant-remove"
                  aria-label={`Remove ${participant.displayName}`}
                  onClick={() => setConfirming(participant.id)}
                >
                  Remove
                </button>
              )}
              {iOwnIt && room?.isMain && sessionCode && participant.id !== meId && (
                <button
                  type="button"
                  className="ghost participant-remove"
                  aria-label={`Make ${participant.displayName} the owner`}
                  onClick={() => setHandingTo(participant.id)}
                >
                  Make owner
                </button>
              )}
              <span
                className={participant.connected ? "presence-dot" : "presence-dot away"}
                aria-hidden="true"
              />
              <span className="visually-hidden">
                {participant.connected ? " — connected" : " — disconnected"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
