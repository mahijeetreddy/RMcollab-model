import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { MAX_TITLE_CHARS, mediaTitle, type MediaItem } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";

/** Who is looking, and whose room it is: decides which actions are offered. */
export interface Manage {
  roomId: string;
  meId: string;
  ownerId: string | null;
  /** The room's owner or the session's: may manage anyone's uploads here. */
  moderator?: boolean;
}

const message = (cause: unknown, fallback: string) => (cause instanceof ApiError ? cause.message : fallback);

/**
 * An upload's title, renameable in place, and its menu: Rename and Delete for
 * whoever added it (or the room's owner). The gateway enforces the same rule;
 * this only avoids offering what would be refused.
 */
export function CardTitle({ item, manage }: { item: MediaItem; manage: Manage | null }) {
  const title = mediaTitle(item);
  const mine = Boolean(
    manage && (item.uploaderId === manage.meId || manage.moderator || (manage.ownerId && manage.ownerId === manage.meId)),
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!menu && !confirming) return;
    const close = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) {
        setMenu(false);
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [menu, confirming]);

  const save = async () => {
    const next = draft.trim();
    setEditing(false);
    if (!manage || next === title) return;
    setError(null);
    try {
      await api.renameMedia(manage.roomId, item.id, manage.meId, next);
    } catch (cause) {
      setError(message(cause, "Could not rename it."));
      setDraft(title);
    }
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") void save();
    if (event.key === "Escape") {
      setDraft(title);
      setEditing(false);
    }
  };
  const remove = async () => {
    if (!manage) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteMedia(manage.roomId, item.id, manage.meId);
      // The room hears media_deleted and the card goes.
    } catch (cause) {
      setError(message(cause, "Could not delete it."));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="job-title-wrap" ref={wrap}>
      {editing ? (
        <input
          ref={input}
          className="job-title-input"
          value={draft}
          maxLength={MAX_TITLE_CHARS}
          aria-label="Upload name"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKey}
          onBlur={() => void save()}
        />
      ) : (
        <h3 className="job-title" title={title}>
          {title}
        </h3>
      )}
      {mine && !editing && (
        <>
          <button
            type="button"
            className="ghost job-menu-toggle"
            aria-label={`Actions for ${title}`}
            aria-expanded={menu}
            onClick={() => setMenu((v) => !v)}
          >
            ⋯
          </button>
          {menu && (
            <div className="job-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(false);
                  setDraft(title);
                  setEditing(true);
                }}
              >
                Rename
              </button>
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  setMenu(false);
                  setConfirming(true);
                }}
              >
                Delete
              </button>
            </div>
          )}
          {confirming && (
            <div className="job-menu job-confirm" role="alertdialog" aria-label={`Delete ${title}?`}>
              <p>
                Delete <strong>{title}</strong> for everyone? Its results, its section in the notes and its files go too.
              </p>
              <div className="job-confirm-actions">
                <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                  Cancel
                </button>
                <button type="button" className="danger" onClick={() => void remove()} disabled={busy} autoFocus>
                  {busy ? "Deleting…" : "Delete"}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="job-action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Runs a failed upload again, with the same strategy. Anyone in the room may. */
export function RetryButton({ item, manage }: { item: MediaItem; manage: Manage | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!manage) return null;
  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retryMedia(manage.roomId, item.id, manage.meId);
    } catch (cause) {
      setError(message(cause, "Could not retry it."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className="job-retry" onClick={() => void retry()} disabled={busy}>
        {busy ? "Retrying…" : "Retry"}
      </button>
      {error && (
        <span className="job-action-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
