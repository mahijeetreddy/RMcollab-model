import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { findMatches, parseTranscript } from "../../lib/transcript";
import type { DocumentFocus } from "./focus";

interface Props {
  text: string;
  /** Seconds into the recording that is playing now, or null if nothing is. */
  playhead: number | null;
  /** Jumps the recording to a segment; absent when there is nothing to play. */
  onSeek?: (seconds: number) => void;
  /** A line to bring into view, from a library hit. Never starts playback. */
  target?: DocumentFocus | null;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const matches = findMatches(text, query);
  if (matches.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let at = 0;
  matches.forEach(([start, end], index) => {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<mark key={index}>{text.slice(start, end)}</mark>);
    at = end;
  });
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}

export function TranscriptView({ text, playhead, onSeek, target = null }: Props) {
  const segments = useMemo(() => parseTranscript(text), [text]);
  const [query, setQuery] = useState("");
  const [targetIndex, setTargetIndex] = useState(-1);
  const listRef = useRef<HTMLOListElement | null>(null);
  const searchId = useId();

  // The hit is the last line starting at or before the matched time. A local
  // search would hide it, so it is cleared first.
  useEffect(() => {
    if (!target || target.atSeconds === null || segments.length === 0) return;
    const at = target.atSeconds;
    let index = 0;
    segments.forEach((segment, i) => {
      if (segment.start <= at) index = i;
    });
    setQuery("");
    setTargetIndex(index);
    const timer = window.setTimeout(() => setTargetIndex(-1), 2400);
    return () => window.clearTimeout(timer);
  }, [target, segments]);

  useEffect(() => {
    if (targetIndex < 0) return;
    const line = listRef.current?.querySelector<HTMLElement>(`[data-index="${targetIndex}"]`);
    line?.scrollIntoView({ block: "nearest" });
  }, [targetIndex]);

  const visible = query.trim()
    ? segments.filter((segment) => findMatches(segment.text, query).length > 0)
    : segments;

  // The segment being spoken is the last one that has started.
  let current = -1;
  if (playhead !== null) {
    for (let i = 0; i < segments.length && segments[i]!.start <= playhead; i += 1) current = i;
  }

  return (
    <div className="transcript">
      <div className="doc-search">
        <label htmlFor={searchId} className="visually-hidden">
          Search the transcript
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Search the transcript"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="doc-search-count" aria-live="polite">
          {query.trim()
            ? `${visible.length} of ${segments.length} ${segments.length === 1 ? "line" : "lines"}`
            : `${segments.length} ${segments.length === 1 ? "line" : "lines"}`}
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="empty">Nothing in the transcript matches “{query.trim()}”.</p>
      ) : (
        <ol className="transcript-lines" tabIndex={0} aria-label="Transcript" ref={listRef}>
          {visible.map((segment) => {
            const index = segments.indexOf(segment);
            const isCurrent = index === current;
            const classes = [isCurrent ? "is-current" : "", index === targetIndex ? "is-target" : ""]
              .filter(Boolean)
              .join(" ");
            return (
              <li
                key={`${segment.start}-${segment.stamp}-${segment.text.slice(0, 16)}`}
                data-index={index}
                className={classes || undefined}
                aria-current={isCurrent ? "true" : undefined}
              >
                {onSeek ? (
                  <button
                    type="button"
                    className="transcript-stamp"
                    onClick={() => onSeek(segment.start)}
                    aria-label={`Play from ${segment.stamp}`}
                  >
                    {segment.stamp}
                  </button>
                ) : (
                  <span className="transcript-stamp">{segment.stamp}</span>
                )}
                <span className="transcript-text">
                  <Highlighted text={segment.text} query={query} />
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
