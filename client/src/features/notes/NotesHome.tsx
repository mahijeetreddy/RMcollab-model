import { useEffect, useRef, useState } from "react";
import type { RoomDocument } from "@rmcollab/shared";
import { api, ApiError } from "../../api/client";
import { visitedAgo } from "../../lib/recent";
import { docIcons } from "./icons";

interface Props {
  roomId: string;
  roomName: string;
  meId: string;
  ownerId: string | null;
  /** The room's owner or the session's: may rename and delete anyone's documents. */
  moderator?: boolean;
  /** The room's documents as last announced over the socket; null until one arrives. */
  live: RoomDocument[] | null;
  onOpen: (docId: string) => void;
}

const message = (cause: unknown, fallback: string) => (cause instanceof ApiError ? cause.message : fallback);

/**
 * A room's documents, before any one of them: like a folder. The room's own
 * notes come first - uploads write into it - and anyone can start another.
 * The list follows the room live: a document someone else makes appears here.
 */
export function NotesHome({ roomId, roomName, meId, ownerId, moderator = false, live, onOpen }: Props) {
  const [fetched, setFetched] = useState<RoomDocument[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setFetched(null);
    api
      .listDocuments(roomId, meId)
      .then((docs) => current && setFetched(docs))
      .catch((cause: unknown) => current && setError(message(cause, "Could not load the documents.")));
    return () => {
      current = false;
    };
  }, [roomId, meId]);

  const documents = live ?? fetched;

  const create = async () => {
    setCreating(true);
    setError(null);
    try {
      const doc = await api.createDocument(roomId, meId, "Untitled document");
      onOpen(doc.id);
    } catch (cause) {
      setError(message(cause, "Could not create a document."));
      setCreating(false);
    }
  };

  return (
    <section className="docs-home" aria-labelledby="docs-heading">
      <header className="docs-home-head">
        <div>
          <h3 id="docs-heading">{roomName} documents</h3>
          <p>Everyone in the room edits these together, live. Uploads land in Room notes.</p>
        </div>
        <button type="button" className="primary docs-new" onClick={() => void create()} disabled={creating}>
          <span aria-hidden="true">+</span> {creating ? "Creating…" : "New document"}
        </button>
      </header>

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {documents === null ? (
        <ul className="docs-grid" aria-busy="true">
          {[0, 1].map((i) => (
            <li key={i} className="doc-card is-loading" aria-hidden="true" />
          ))}
        </ul>
      ) : (
        <ul className="docs-grid">
          {documents.map((doc) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              roomId={roomId}
              meId={meId}
              mayManage={!doc.isMain && (doc.createdBy === meId || moderator || (ownerId !== null && ownerId === meId))}
              onOpen={() => onOpen(doc.id)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function DocumentCard({
  doc,
  roomId,
  meId,
  mayManage,
  onOpen,
}: {
  doc: RoomDocument;
  roomId: string;
  meId: string;
  mayManage: boolean;
  onOpen: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState(doc.title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const wrap = useRef<HTMLLIElement | null>(null);

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

  const rename = async () => {
    const title = draft.trim();
    setRenaming(false);
    if (!title || title === doc.title) {
      setDraft(doc.title);
      return;
    }
    try {
      await api.renameDocument(roomId, doc.id, meId, title);
    } catch (cause) {
      setError(message(cause, "Could not rename it."));
      setDraft(doc.title);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteDocument(roomId, doc.id, meId);
    } catch (cause) {
      setError(message(cause, "Could not delete it."));
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li className={`doc-card${doc.isMain ? " is-main" : ""}`} ref={wrap}>
      {renaming ? (
        <div className="doc-card-open">
          <span className="doc-card-mark" aria-hidden="true">
            {docIcons.doc}
          </span>
          <input
            className="doc-card-rename"
            value={draft}
            aria-label="Document name"
            maxLength={120}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void rename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void rename();
              if (event.key === "Escape") {
                setDraft(doc.title);
                setRenaming(false);
              }
            }}
          />
        </div>
      ) : (
        <button type="button" className="doc-card-open" onClick={onOpen}>
          <span className="doc-card-mark" aria-hidden="true">
            {docIcons.doc}
          </span>
          <span className="doc-card-text">
            <span className="doc-card-title">{doc.title}</span>
            <span className="doc-card-meta">
              {doc.isMain ? "Uploads land here" : doc.createdByName ? `By ${doc.createdByName}` : "Shared"} · edited{" "}
              {visitedAgo(doc.updatedAt)}
            </span>
          </span>
        </button>
      )}
      {mayManage && !renaming && (
        <button
          type="button"
          className="ghost doc-card-menu-toggle"
          aria-label={`Actions for ${doc.title}`}
          aria-expanded={menu}
          onClick={() => setMenu((v) => !v)}
        >
          ⋯
        </button>
      )}
      {menu && (
        <div className="job-menu doc-card-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
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
        <div className="job-menu job-confirm doc-card-menu" role="alertdialog" aria-label={`Delete ${doc.title}?`}>
          <p>
            Delete <strong>{doc.title}</strong> for everyone? Its text and its history go too.
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
      {error && (
        <p className="job-action-error doc-card-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

