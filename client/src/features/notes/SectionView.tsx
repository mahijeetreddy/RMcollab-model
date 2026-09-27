import { NodeViewContent, NodeViewWrapper, type ReactNodeViewProps } from "@tiptap/react";
import { formatTime } from "../../lib/format";
import { useNotesRoom } from "./context";
import { docIcons } from "./icons";

const KIND_LABEL: Record<string, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };

/**
 * An upload's section: a card with a header the editor does not treat as text
 * (who added what, and how its analysis is going) around content the room
 * edits like any other part of the notes.
 */
export function SectionView({ node }: ReactNodeViewProps) {
  const { media, openInFeed } = useNotesRoom();
  const attrs = node.attrs as {
    mediaItemId: string | null;
    mediaType: string | null;
    title: string | null;
    author: string | null;
    createdAt: number | null;
    status: string | null;
  };
  const entry = attrs.mediaItemId ? media.find((m) => m.mediaItem.id === attrs.mediaItemId) : undefined;
  // Live state when the upload is in this room's snapshot; the document's own
  // record otherwise (an old upload, or a section copied from elsewhere).
  const live = entry?.job?.status;
  const status = live ?? attrs.status ?? "done";
  const progress = Math.round(Math.min(1, Math.max(0, entry?.job?.progress ?? 0)) * 100);
  const kind = attrs.mediaType ?? "text";

  const statusText =
    status === "queued"
      ? "Waiting for a worker"
      : status === "processing"
        ? progress > 0
          ? `Analysing · ${progress}%`
          : "Analysing"
        : status === "failed"
          ? "Could not be processed"
          : "Added to notes";

  return (
    <NodeViewWrapper as="section" className={`doc-section doc-section-${kind} is-${status}`} data-type="uploadSection">
      <header className="doc-section-head" contentEditable={false}>
        <span className="doc-section-icon" aria-hidden="true">
          {docIcons[kind as keyof typeof docIcons] ?? docIcons.text}
        </span>
        <span className="doc-section-meta">
          <span className="doc-section-title">{attrs.title ?? "Upload"}</span>
          <span className="doc-section-sub">
            {KIND_LABEL[kind] ?? "Upload"}
            {attrs.author ? ` · ${attrs.author}` : ""}
            {attrs.createdAt ? ` · ${formatTime(Number(attrs.createdAt))}` : ""}
          </span>
        </span>
        <span className={`doc-section-status is-${status}`} role="status">
          {(status === "processing" || status === "queued") && <span className="doc-section-spinner" aria-hidden="true" />}
          {statusText}
        </span>
        {attrs.mediaItemId && (
          <button
            type="button"
            className="doc-section-open"
            onClick={() => openInFeed(attrs.mediaItemId!)}
            title="Open the original and every result in the feed"
          >
            Open
          </button>
        )}
        {status === "processing" && (
          <span className="doc-section-progress" aria-hidden="true">
            <span style={{ width: `${Math.max(progress, 4)}%` }} />
          </span>
        )}
      </header>
      <NodeViewContent className="doc-section-body" />
    </NodeViewWrapper>
  );
}
