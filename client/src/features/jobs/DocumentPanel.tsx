import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Artifact } from "@rmcollab/shared";
import { resolveFileUrl } from "../../api/client";
import { formatDuration } from "../../lib/transcript";
import { SummaryView } from "./SummaryView";
import { TranscriptView } from "./TranscriptView";
import type { DocumentFocus } from "./focus";
import { useTextContent } from "./useTextContent";

interface Props {
  documents: Artifact[];
  /** The upload's name without extension, for downloaded file names. */
  baseName: string;
  playhead: number | null;
  onSeek?: (seconds: number) => void;
  focus?: DocumentFocus | null;
}

// A summary is what most people open a job for, so it leads when there is one.
const ORDER: Record<string, number> = { summary: 0, transcript: 1 };

/** Short facts from an artifact's meta, shown under the tabs. Unknown keys are ignored. */
function describe(artifact: Artifact): string[] {
  const meta = artifact.meta;
  const facts: string[] = [];
  const str = (key: string) => (typeof meta[key] === "string" ? (meta[key] as string) : null);
  const num = (key: string) => (typeof meta[key] === "number" ? (meta[key] as number) : null);

  if (artifact.kind === "transcript") {
    const duration = num("durationS");
    const language = str("language");
    const rtf = num("realTimeFactor");
    if (duration !== null) facts.push(formatDuration(duration));
    if (language) facts.push(language.toUpperCase());
    if (str("model")) facts.push(`Whisper ${str("model")}`);
    if (rtf !== null && rtf > 0) facts.push(`${(1 / rtf).toFixed(1)}× real time`);
    if (meta["denoised"] === true) facts.push("denoised");
  } else if (artifact.kind === "summary") {
    if (str("model")) facts.push(str("model")!);
    const chunks = num("chunks");
    if (chunks !== null && chunks > 1) facts.push(`${chunks} parts merged`);
  }
  return facts;
}

function extensionFor(artifact: Artifact): string {
  if (artifact.mimeType === "text/markdown") return "md";
  return "txt";
}

function download(text: string, filename: string, mimeType: string) {
  // The file server is another origin, where an <a download> is ignored and the
  // browser would navigate instead; a local blob always saves.
  const url = URL.createObjectURL(new Blob([text], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function DocumentPanel({ documents, baseName, playhead, onSeek, focus = null }: Props) {
  const sorted = [...documents].sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9));
  const [activeId, setActiveId] = useState<string | null>(sorted[0]?.id ?? null);
  const [status, setStatus] = useState("");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  // A summary can land after the transcript is already on screen; keep the
  // viewer where they are rather than yanking them to the new tab.
  const active = sorted.find((doc) => doc.id === activeId) ?? sorted[0] ?? null;
  const text = useTextContent(active ? resolveFileUrl(active.url) : null, Boolean(active));

  // Opening a document from the library selects its tab. Keyed on the request
  // alone: `documents` is rebuilt every render, and depending on it would pin
  // the tab and stop the viewer switching away.
  useEffect(() => {
    if (focus) setActiveId(focus.artifactId);
  }, [focus]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 2000);
    return () => window.clearTimeout(timer);
  }, [status]);

  if (!active) return null;

  const onTabKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const jump = event.key === "Home" ? 0 : event.key === "End" ? sorted.length - 1 : null;
    if (!step && jump === null) return;
    event.preventDefault();
    const next = jump ?? (index + step + sorted.length) % sorted.length;
    setActiveId(sorted[next]!.id);
    tabRefs.current[next]?.focus();
  };

  const copy = async () => {
    if (text.value === null) return;
    try {
      await navigator.clipboard.writeText(text.value);
      setStatus(`${active.label} copied`);
    } catch {
      setStatus("Copy was blocked by the browser");
    }
  };

  const facts = describe(active);
  const panelId = `${baseId}-panel`;

  return (
    <section className="doc-panel" aria-label="Documents">
      <div className="doc-bar">
        <div className="doc-tabs" role="tablist" aria-label="Documents">
          {sorted.map((doc, index) => {
            const selected = doc.id === active.id;
            return (
              <button
                key={doc.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                id={`${baseId}-tab-${index}`}
                aria-selected={selected}
                aria-controls={panelId}
                tabIndex={selected ? 0 : -1}
                className={`doc-tab doc-tab-${doc.kind}`}
                onClick={() => setActiveId(doc.id)}
                onKeyDown={(event) => onTabKey(event, index)}
              >
                {doc.label}
              </button>
            );
          })}
        </div>
        <div className="doc-actions">
          <span className="doc-status" role="status">
            {status}
          </span>
          <button type="button" className="ghost doc-action" onClick={copy} disabled={text.value === null}>
            Copy
          </button>
          <button
            type="button"
            className="ghost doc-action"
            disabled={text.value === null}
            onClick={() =>
              text.value !== null &&
              download(
                text.value,
                `${baseName}-${active.kind}.${extensionFor(active)}`,
                active.mimeType ?? "text/plain",
              )
            }
          >
            Download
          </button>
        </div>
      </div>

      <div
        className="doc-body"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${baseId}-tab-${sorted.indexOf(active)}`}
      >
        {facts.length > 0 && (
          <p className="doc-facts">
            {facts.map((fact) => (
              <span key={fact}>{fact}</span>
            ))}
          </p>
        )}
        {text.loading ? (
          <p className="empty">Loading…</p>
        ) : text.error ? (
          <p className="empty">{text.error}</p>
        ) : text.value === null ? null : active.kind === "transcript" ? (
          <TranscriptView
            text={text.value}
            playhead={playhead}
            onSeek={onSeek}
            target={focus && focus.artifactId === active.id ? focus : null}
          />
        ) : active.kind === "summary" || active.mimeType === "text/markdown" ? (
          <SummaryView text={text.value} />
        ) : (
          <pre className="text-pane">{text.value}</pre>
        )}
      </div>
    </section>
  );
}
