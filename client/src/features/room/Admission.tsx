import { useEffect, useState } from "react";
import { formatSessionCode } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";

const message = (cause: unknown, fallback: string) => (cause instanceof ApiError ? cause.message : fallback);

/** The screen someone new sees while the waiting room holds them. */
export function WaitingScreen({
  sessionName,
  ownerName,
  onCancel,
}: {
  sessionName: string | null;
  ownerName: string | null;
  onCancel: () => void;
}) {
  return (
    <main className="waiting" id="main-content">
      <div className="waiting-card" role="status" aria-live="polite">
        <span className="waiting-pulse" aria-hidden="true" />
        <h1>Waiting to be let in</h1>
        <p>
          {ownerName ? `${ownerName} will let you into` : "The session's owner will let you into"}{" "}
          {sessionName ? <strong>{sessionName}</strong> : "this session"} shortly. This page updates by itself.
        </p>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </main>
  );
}

/**
 * For the session's owner: who is waiting, with Admit and Deny. Live requests
 * come over the socket; anyone already waiting when the owner arrived is
 * fetched once.
 */
export function AdmissionRequests({
  sessionCode,
  ownerId,
  live,
  decided,
}: {
  sessionCode: string;
  ownerId: string;
  live: { id: string; displayName: string }[];
  decided: string[];
}) {
  const [earlier, setEarlier] = useState<{ id: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .waitingList(sessionCode, ownerId)
      .then(setEarlier)
      .catch(() => undefined);
  }, [sessionCode, ownerId]);

  const seen = new Set<string>();
  const waiting = [...earlier, ...live].filter((p) => {
    if (seen.has(p.id) || decided.includes(p.id)) return false;
    seen.add(p.id);
    return true;
  });
  if (waiting.length === 0) return null;

  const decide = async (targetId: string, admit: boolean) => {
    setBusy(targetId);
    setError(null);
    try {
      await api.decideAdmission(sessionCode, ownerId, targetId, admit);
      setEarlier((list) => list.filter((p) => p.id !== targetId));
    } catch (cause) {
      setError(message(cause, "That didn't go through. Try again."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="admissions" role="region" aria-label="People waiting to join">
      {waiting.map((p) => (
        <div key={p.id} className="admission" role="alertdialog" aria-label={`${p.displayName} wants to join`}>
          <span className="admission-avatar" aria-hidden="true">
            {p.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="admission-text">
            <strong>{p.displayName}</strong> wants to join
          </span>
          <button type="button" className="ghost" disabled={busy === p.id} onClick={() => void decide(p.id, false)}>
            Deny
          </button>
          <button type="button" className="primary" disabled={busy === p.id} onClick={() => void decide(p.id, true)}>
            Admit
          </button>
        </div>
      ))}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The owner's switch for the waiting room. */
export function WaitingRoomToggle({ sessionCode, ownerId, on }: { sessionCode: string; ownerId: string; on: boolean }) {
  // What was asked for, shown until the session's own update confirms it.
  const [wanted, setWanted] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (wanted === on) setWanted(null);
  }, [on, wanted]);
  const toggle = async () => {
    const next = !(wanted ?? on);
    setWanted(next);
    setError(null);
    try {
      await api.setWaitingRoom(sessionCode, ownerId, next);
    } catch (cause) {
      setWanted(null);
      setError(message(cause, "Could not change it."));
    }
  };
  return (
    <div className="waiting-toggle">
      <label className="waiting-toggle-row">
        <input type="checkbox" role="switch" checked={wanted ?? on} onChange={() => void toggle()} />
        <span>
          <span className="waiting-toggle-title">Waiting room</span>
          <span className="waiting-toggle-detail">New people wait until you let them in</span>
        </span>
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** After removing someone from the session: its new code, ready to share. */
export function NewCodeNotice({ code, name, onClose }: { code: string; name: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(formatSessionCode(code));
      setCopied(true);
    } catch {
      window.prompt("The session's new code:", formatSessionCode(code));
    }
  };
  return (
    <div className="new-code" role="status">
      <p>
        The session code is now <code>{formatSessionCode(code)}</code>, so {name} can't come back with the old one. People
        already here are not affected.
      </p>
      <div className="job-confirm-actions">
        <button type="button" className="ghost" onClick={onClose}>
          Done
        </button>
        <button type="button" className="primary" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy new code"}
        </button>
      </div>
    </div>
  );
}
