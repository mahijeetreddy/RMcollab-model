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
}

export function ParticipantList({ participants, meId, ownerId, room = null }: Props) {
  const iOwnIt = Boolean(meId && ownerId && meId === ownerId && room);
  const [confirming, setConfirming] = useState<string | null>(null);
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
          <div className="room-delete-confirm participant-confirm" role="alertdialog" aria-label={`Remove ${target.displayName}?`}>
            <p>
              {room.isMain ? (
                <>
                  Remove <strong>{target.displayName}</strong> from the session? They are disconnected, and can only come
                  back with the code as someone new.
                </>
              ) : (
                <>
                  Remove <strong>{target.displayName}</strong> from <strong>{room.name}</strong>? They move to the main room
                  and can't come back into this one.
                </>
              )}
            </p>
            <div className="job-confirm-actions">
              <button type="button" className="ghost" onClick={() => setConfirming(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => void remove(target)} disabled={busy} autoFocus>
                {busy ? "Removing…" : "Remove"}
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
