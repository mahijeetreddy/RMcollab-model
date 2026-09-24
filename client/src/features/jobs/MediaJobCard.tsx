import { useEffect, useRef, useState } from "react";
import type { JobStatus, MediaItem, MediaItemWithJob, MediaType } from "@rmcollab/shared";
import { resolveFileUrl } from "../../api/client";
import { formatBytes, formatTime, MEDIA_TYPE_LABELS } from "../../lib/format";
import { useTextContent } from "./useTextContent";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "Queued",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

/** A glyph plus the word, so status never depends on colour alone. */
const STATUS_GLYPH: Record<JobStatus, string> = {
  queued: "◔",
  processing: "◍",
  done: "✓",
  failed: "✕",
};

interface PaneProps {
  label: string;
  url: string | null;
  mediaType: MediaType;
  item: MediaItem;
  active: boolean;
  placeholder: string;
  altPrefix: string;
}

function MediaPane({ label, url, mediaType, item, active, placeholder, altPrefix }: PaneProps) {
  const text = useTextContent(mediaType === "text" ? url : null, active && mediaType === "text");
  const name = item.originalFilename ?? `${MEDIA_TYPE_LABELS[mediaType].toLowerCase()} upload`;

  return (
    <div className="compare-pane">
      <div className="compare-label">
        <span>{label}</span>
        {url && (
          <a href={url} target="_blank" rel="noreferrer">
            Open
            <span className="visually-hidden">{` ${label.toLowerCase()} ${name} in a new tab`}</span>
          </a>
        )}
      </div>
      {!url || !active ? (
        <p className="empty">{placeholder}</p>
      ) : mediaType === "image" ? (
        <img src={url} alt={`${altPrefix} ${name}`} loading="lazy" />
      ) : mediaType === "video" ? (
        <video src={url} controls preload="metadata" aria-label={`${altPrefix} ${name}`} />
      ) : mediaType === "audio" ? (
        <audio src={url} controls preload="metadata" aria-label={`${altPrefix} ${name}`} />
      ) : text.loading ? (
        <p className="empty">Loading…</p>
      ) : text.error ? (
        <p className="empty">{text.error}</p>
      ) : (
        <pre className="text-pane" aria-label={`${altPrefix} ${name}`} tabIndex={0}>
          {text.value}
        </pre>
      )}
    </div>
  );
}

export function MediaJobCard({ mediaItem, job }: MediaItemWithJob) {
  const status: JobStatus = job?.status ?? "queued";
  const progress = Math.min(1, Math.max(0, job?.progress ?? 0));
  const percent = Math.round(progress * 100);
  const originalUrl = resolveFileUrl(mediaItem.originalUrl);
  // Before/after only makes sense for an artifact that replaces the original.
  // A transcript or a summary is a derived document, shown in its own right.
  const artifacts = job?.artifacts ?? [];
  const enhanced = artifacts.find((a) => a.kind === "enhanced") ?? null;
  const documents = artifacts.filter((a) => a.kind !== "enhanced");
  const resultUrl = resolveFileUrl(enhanced?.url ?? null);
  const size = formatBytes(mediaItem.sizeBytes);
  const indeterminate = status === "processing" && progress === 0;
  const running = status === "queued" || status === "processing";
  const label = mediaItem.originalFilename ?? `${MEDIA_TYPE_LABELS[mediaItem.mediaType]} upload`;

  // One-shot celebration when a job lands on DONE in front of the viewer.
  const previousStatus = useRef<JobStatus>(status);
  const [justFinished, setJustFinished] = useState(false);
  useEffect(() => {
    if (previousStatus.current !== "done" && status === "done") {
      setJustFinished(true);
      const timer = window.setTimeout(() => setJustFinished(false), 800);
      previousStatus.current = status;
      return () => window.clearTimeout(timer);
    }
    previousStatus.current = status;
  }, [status]);

  const cardClass = [
    "job-card",
    running ? "is-running" : "",
    status === "done" ? "is-done" : "",
    status === "failed" ? "is-failed" : "",
    justFinished ? "just-finished" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cardClass} aria-label={`${label}, ${STATUS_LABEL[status]}`}>
      <header className="job-head">
        <span className="job-uploader">{mediaItem.uploaderName}</span>
        <span className="badge">{MEDIA_TYPE_LABELS[mediaItem.mediaType]}</span>
        {job && (
          <span className="badge badge-strategy">
            <span className="visually-hidden">Strategy: </span>
            {job.strategy}
          </span>
        )}
        {mediaItem.originalFilename && (
          <span className="job-filename" title={mediaItem.originalFilename}>
            {mediaItem.originalFilename}
            {size ? ` · ${size}` : ""}
          </span>
        )}
        <span className="job-head-spacer" />
        <time className="chat-time" dateTime={new Date(mediaItem.createdAt).toISOString()}>
          {formatTime(mediaItem.createdAt)}
        </time>
        <span className={`badge badge-status-${status}`}>
          <span className="badge-glyph" aria-hidden="true">
            {STATUS_GLYPH[status]}
          </span>
          {STATUS_LABEL[status]}
        </span>
      </header>

      <div className="progress">
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={status === "done" ? 100 : percent}
          aria-valuetext={`${status === "done" ? 100 : percent}% — ${STATUS_LABEL[status]}`}
          aria-label={`Enhancement progress for ${label}`}
        >
          <div
            className={`progress-fill${status === "done" ? " done" : ""}${
              status === "failed" ? " failed" : ""
            }${indeterminate ? " indeterminate" : ""}${
              status === "processing" && !indeterminate ? " active" : ""
            }`}
            style={{ width: status === "done" ? "100%" : `${indeterminate ? 100 : percent}%` }}
          />
        </div>
        <div className="progress-meta">
          <span>{job?.message ?? (status === "queued" ? "Waiting for a worker" : "")}</span>
          <strong>{status === "failed" ? "—" : `${status === "done" ? 100 : percent}%`}</strong>
        </div>
      </div>

      {status === "failed" && (
        <p className="job-fail">{job?.error ?? "Enhancement failed with no reported reason."}</p>
      )}

      {/* A comprehension job replaces the original rather than improving it, so
          the side-by-side is only shown when the job actually produced one. */}
      {(enhanced || documents.length === 0) && (
        <div className="compare">
          <MediaPane
            label="Original"
            url={originalUrl}
            mediaType={mediaItem.mediaType}
            item={mediaItem}
            active={Boolean(originalUrl)}
            placeholder="No original available"
            altPrefix="Original upload:"
          />
          <MediaPane
            label="Enhanced"
            url={resultUrl}
            mediaType={mediaItem.mediaType}
            item={mediaItem}
            active={status === "done" && Boolean(resultUrl)}
            placeholder={status === "failed" ? "No result produced" : "Awaiting result…"}
            altPrefix={`Enhanced result${job ? ` from ${job.strategy}` : ""}:`}
          />
        </div>
      )}

      {documents.length > 0 && (
        <ul className="artifact-list">
          {documents.map((artifact) => (
            <li key={artifact.id}>
              <span className="artifact-kind">{artifact.kind}</span>
              <span className="artifact-label">{artifact.label}</span>
              <a href={resolveFileUrl(artifact.url) ?? "#"} target="_blank" rel="noreferrer">
                Open
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
