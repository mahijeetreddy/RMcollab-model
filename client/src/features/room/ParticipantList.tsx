import { useEffect, useRef, useState } from "react";
import type { Participant } from "@rmcollab/shared";
import { initials } from "../../lib/format";

interface Props {
  participants: Participant[];
  meId: string | null;
  /** Creator of the active room; null for the main room, which has no owner. */
  ownerId: string | null;
}

export function ParticipantList({ participants, meId, ownerId }: Props) {
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
