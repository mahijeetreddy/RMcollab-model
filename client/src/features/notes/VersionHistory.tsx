import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api/client";

interface Version {
  id: string;
  createdAt: number;
  reason: string;
  words: number;
}

interface Preview {
  version: Version;
  sections: { title: string; text: string }[];
}

interface Props {
  roomId: string;
  docId: string;
  participantId: string;
  onClose: () => void;
}

function when(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${date.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

const message = (cause: unknown, fallback: string) => (cause instanceof ApiError ? cause.message : fallback);

/**
 * The notes' restore points, like a document editor's version history: pick
 * one to preview it, restore it if it is the one. Restoring saves the notes as
 * they are first, so a restore can itself be undone from this same list.
 */
export function VersionHistory({ roomId, docId, participantId, onClose }: Props) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api
      .listVersions(roomId, participantId, docId)
      .then((list) => {
        setVersions(list);
        if (list[0]) setSelected(list[0].id);
      })
      .catch((cause: unknown) => setError(message(cause, "Could not load the history.")));
  }, [roomId, participantId, docId]);

  useEffect(() => {
    if (!selected) return;
    setPreview(null);
    setConfirming(false);
    let live = true;
    api
      .getVersion(roomId, participantId, docId, selected)
      .then((p) => live && setPreview(p))
      .catch((cause: unknown) => live && setError(message(cause, "Could not load that version.")));
    return () => {
      live = false;
    };
  }, [roomId, participantId, docId, selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialog.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api.restoreVersion(roomId, participantId, docId, selected);
      onClose();
    } catch (cause) {
      setError(message(cause, "Could not restore it."));
      setBusy(false);
    }
  };

  return (
    <div className="history-backdrop" onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="history" role="dialog" aria-modal="true" aria-labelledby="history-heading" tabIndex={-1} ref={dialog}>
        <header className="history-head">
          <div>
            <h2 id="history-heading">Version history</h2>
            <p>Saved hourly while the notes are edited, and before anything large is deleted.</p>
          </div>
          <button type="button" className="ask-close" onClick={onClose} aria-label="Close version history">
            <span aria-hidden="true">✕</span>
          </button>
        </header>

        <div className="history-body">
          <ol className="history-list" aria-label="Saved versions">
            {versions === null && !error && <li className="history-empty">Loading…</li>}
            {versions?.length === 0 && (
              <li className="history-empty">No versions yet. The first is saved once the notes are edited.</li>
            )}
            {versions?.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className="history-item"
                  aria-pressed={selected === v.id}
                  onClick={() => setSelected(v.id)}
                >
                  <span className="history-when">{when(v.createdAt)}</span>
                  <span className="history-reason">
                    {v.reason} · {v.words.toLocaleString()} words
                  </span>
                </button>
              </li>
            ))}
          </ol>

          <section className="history-preview" aria-label="Preview" aria-busy={Boolean(selected && !preview)}>
            {preview ? (
              <>
                <div className="history-preview-doc">
                  {preview.sections.length === 0 ? (
                    <p className="history-empty">These notes were empty.</p>
                  ) : (
                    preview.sections.map((s, i) => (
                      <div key={i} className="history-section">
                        <h3>{s.title}</h3>
                        <p>{s.text}</p>
                      </div>
                    ))
                  )}
                </div>
                <footer className="history-actions">
                  {confirming ? (
                    <>
                      <span className="history-confirm">
                        Replace the notes for everyone with this version? What is there now is kept in the history.
                      </span>
                      <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                        Cancel
                      </button>
                      <button type="button" className="primary" onClick={() => void restore()} disabled={busy} autoFocus>
                        {busy ? "Restoring…" : "Restore"}
                      </button>
                    </>
                  ) : (
                    <button type="button" className="primary" onClick={() => setConfirming(true)}>
                      Restore this version
                    </button>
                  )}
                </footer>
              </>
            ) : (
              selected && <p className="history-empty">Loading…</p>
            )}
          </section>
        </div>
        {error && (
          <p className="error-text history-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
