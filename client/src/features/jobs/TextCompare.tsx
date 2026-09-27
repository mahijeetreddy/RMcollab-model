import { useMemo, useState, type ReactNode } from "react";
import { diffStats, diffText } from "../../lib/diff";
import { useTextContent } from "./useTextContent";

interface Props {
  originalUrl: string;
  resultUrl: string;
  name: string;
  strategy: string | null;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/**
 * Original beside rewrite, with the rewrite's edits marked inline. Side by side
 * alone, a careful rewrite of already-clean prose reads as "nothing changed";
 * the marks make a dozen small edits visible at a glance.
 */
export function TextCompare({ originalUrl, resultUrl, name, strategy }: Props) {
  const original = useTextContent(originalUrl, true);
  const result = useTextContent(resultUrl, true);
  const [showChanges, setShowChanges] = useState(true);

  const parts = useMemo(
    () => (original.value !== null && result.value !== null ? diffText(original.value, result.value) : null),
    [original.value, result.value],
  );
  const stats = useMemo(() => (parts ? diffStats(parts) : null), [parts]);

  const summary = !stats
    ? ""
    : stats.changes === 0
      ? "No changes"
      : `${plural(stats.changes, "edit")} · +${stats.wordsAdded} / −${stats.wordsRemoved} words`;

  const pane = (content: typeof original, body: ReactNode, label: string) =>
    content.loading ? (
      <p className="empty">Loading…</p>
    ) : content.error ? (
      <p className="empty">{content.error}</p>
    ) : (
      <pre className="text-pane" aria-label={label} tabIndex={0}>
        {body}
      </pre>
    );

  return (
    <div className="compare">
      <div className="compare-pane">
        <div className="compare-label">
          <span>Original</span>
          <a href={originalUrl} target="_blank" rel="noreferrer">
            Open<span className="visually-hidden">{` original ${name} in a new tab`}</span>
          </a>
        </div>
        {pane(original, original.value, `Original upload: ${name}`)}
      </div>

      <div className="compare-pane">
        <div className="compare-label">
          <span>Enhanced</span>
          <span className="diff-summary" aria-live="polite">
            {summary}
          </span>
          <span className="compare-actions">
            {stats && stats.changes > 0 && (
              <button
                type="button"
                className="diff-toggle"
                aria-pressed={showChanges}
                onClick={() => setShowChanges((on) => !on)}
              >
                Show changes
              </button>
            )}
            <a href={resultUrl} target="_blank" rel="noreferrer">
              Open<span className="visually-hidden">{` enhanced ${name} in a new tab`}</span>
            </a>
          </span>
        </div>
        {pane(
          result,
          showChanges && parts
            ? parts.map((part, index) =>
                part.op === "insert" ? (
                  <ins key={index}>{part.text}</ins>
                ) : part.op === "delete" ? (
                  <del key={index}>{part.text}</del>
                ) : (
                  part.text
                ),
              )
            : result.value,
          `Enhanced result${strategy ? ` from ${strategy}` : ""}: ${name}${showChanges ? ", with changes marked" : ""}`,
        )}
      </div>
    </div>
  );
}
