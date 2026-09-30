import { useEffect, useId, useState } from "react";
import { mediaTitle, type ArtifactKind, type LibraryEntry } from "@rmcollab/shared";
import { api, resolveFileUrl } from "../../api/client";
import { parseSnippet } from "../../lib/snippet";
import { formatDuration } from "../../lib/transcript";

interface Props {
  roomId: string;
  participantId: string;
  /** Changes whenever the room gains a document, so the list refetches. */
  refreshKey: string;
  onOpen: (entry: LibraryEntry) => void;
}

type Filter = "all" | ArtifactKind;

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "summary", label: "Summaries" },
  { value: "transcript", label: "Transcripts" },
  { value: "enhanced", label: "Enhanced" },
];

const SEARCH_DELAY_MS = 250;

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Snippet({ entry }: { entry: LibraryEntry }) {
  if (!entry.snippet) return null;
  const kind = entry.artifact.kind;
  // Summaries (and image notes) are Markdown; show their words, not their syntax.
  const parts = parseSnippet(entry.snippet, kind === "transcript", kind === "summary");
  if (parts.length === 0) return null;
  return (
    <p className="library-snippet">
      {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : part.text))}
    </p>
  );
}

export function LibraryPanel({ roomId, participantId, refreshKey, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchId = useId();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    // Aborting the previous request means a slow answer to an old query can
    // never land on top of the answer to the current one.
    const controller = new AbortController();
    api
      .library(roomId, participantId, debounced, controller.signal)
      .then((next) => {
        setEntries(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load the library");
      });
    return () => controller.abort();
  }, [roomId, participantId, debounced, refreshKey]);

  const searching = debounced.trim().length > 0;
  const visible = (entries ?? []).filter((e) => filter === "all" || e.artifact.kind === filter);
  const countText =
    entries === null
      ? "Loading…"
      : `${visible.length} ${visible.length === 1 ? "document" : "documents"}${
          searching ? ` matching “${debounced.trim()}”` : ""
        }`;

  return (
    <div className="library">
      <div className="library-controls">
        <label htmlFor={searchId} className="visually-hidden">
          Search this room's documents
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Search transcripts, summaries and notes"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="library-filters" role="group" aria-label="Show">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="library-filter"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      <p className="library-count" aria-live="polite">
        {countText}
      </p>

      {error ? (
        <p className="empty">{error}</p>
      ) : entries === null ? null : visible.length === 0 ? (
        <p className="empty">
          {searching
            ? "Nothing in this room matches that. Search matches whole words, so try a shorter form."
            : entries.length === 0
              ? "Nothing here yet. Transcripts, summaries and enhanced files collect here as jobs finish."
              : "No documents of this kind yet."}
        </p>
      ) : (
        <ul className="library-list">
          {visible.map((entry) => {
            const name = mediaTitle({ ...entry, title: entry.title ?? null });
            const thumb =
              entry.artifact.kind === "enhanced" && entry.mediaType === "image"
                ? resolveFileUrl(entry.artifact.url)
                : null;
            return (
              <li key={entry.artifact.id}>
                <button
                  type="button"
                  className="library-entry"
                  onClick={() => onOpen(entry)}
                  aria-label={`Open ${entry.artifact.label.toLowerCase()} of ${name}${
                    entry.atSeconds !== null ? ` at ${formatDuration(entry.atSeconds)}` : ""
                  }`}
                >
                  {thumb && <img className="library-thumb" src={thumb} alt="" loading="lazy" />}
                  <span className="library-main">
                    <span className="library-head">
                      <span className={`library-kind library-kind-${entry.artifact.kind}`}>
                        {entry.artifact.label}
                      </span>
                      <span className="library-name">{name}</span>
                      {entry.atSeconds !== null && (
                        <span className="library-at">at {formatDuration(entry.atSeconds)}</span>
                      )}
                    </span>
                    <Snippet entry={entry} />
                    <span className="library-meta">
                      {entry.uploaderName} · {entry.strategy} · {formatDate(entry.artifact.createdAt)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
