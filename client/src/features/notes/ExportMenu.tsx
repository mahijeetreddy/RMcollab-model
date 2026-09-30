import { useEffect, useId, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { MediaItemWithJob } from "@rmcollab/shared";
import { SECTION_NODE, SECTION_PLACEHOLDER } from "@rmcollab/shared/notes";
import { api } from "../../api/client";
import { exportFileName, notesToMarkdown, type Appendix } from "./exportMarkdown";

interface Props {
  editor: Editor | null;
  roomName: string;
  media: MediaItemWithJob[];
}

const KIND_LABEL: Record<string, string> = { text: "Text", image: "Image", audio: "Recording", video: "Video" };

/** The room's transcripts, fetched for the appendix. One that fails is skipped, not fatal. */
async function transcripts(media: MediaItemWithJob[]): Promise<Appendix[]> {
  const wanted = media.flatMap((entry) =>
    (entry.job?.artifacts ?? [])
      .filter((artifact) => artifact.kind === "transcript")
      .map((artifact) => ({ title: entry.mediaItem.originalFilename ?? artifact.label, url: artifact.url })),
  );
  const texts = await Promise.all(wanted.map(({ url }) => api.fetchTextBlob(url).catch(() => "")));
  return wanted.map(({ title }, i) => ({ title, text: texts[i]! }));
}

function download(name: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked on the next tick: some browsers start the download asynchronously.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Prints a clean copy of the notes rather than the live editor: the app's
 * panels scroll inside fixed heights, which would clip a printed page to one
 * screenful. The copy is the editor's own HTML, so it is exactly what the room
 * sees, with each upload section given its title back.
 */
function printNotes(editor: Editor, roomName: string) {
  const root = document.createElement("div");
  root.className = "print-root";
  const head = document.createElement("header");
  head.className = "print-head";
  const title = document.createElement("h1");
  title.textContent = `${roomName} notes`;
  const stamp = document.createElement("p");
  stamp.textContent = `Printed from RMcollab on ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
  head.append(title, stamp);

  const body = document.createElement("div");
  body.className = "print-body";
  body.innerHTML = editor.getHTML();
  for (const section of Array.from(body.querySelectorAll<HTMLElement>(`section[data-type="${SECTION_NODE}"]`))) {
    const heading = document.createElement("h2");
    heading.textContent = section.dataset.title ?? "Upload";
    const meta = document.createElement("p");
    meta.className = "print-meta";
    const status = section.dataset.status;
    meta.textContent = [
      KIND_LABEL[section.dataset.mediaType ?? ""] ?? "Upload",
      section.dataset.author,
      status === "processing" ? "still being processed" : status === "failed" ? "could not be processed" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (section.textContent?.trim() === SECTION_PLACEHOLDER) section.replaceChildren();
    section.prepend(heading, meta);
  }
  root.append(head, body);
  document.body.append(root);
  const cleanup = () => {
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

export function ExportMenu({ editor, roomName, media }: Props) {
  const [open, setOpen] = useState(false);
  const [withTranscripts, setWithTranscripts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const hasTranscripts = media.some((entry) => entry.job?.artifacts.some((artifact) => artifact.kind === "transcript"));

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        wrap.current?.querySelector<HTMLButtonElement>(".gdoc-export")?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const markdown = async () => {
    if (!editor) return;
    setBusy(true);
    setError(null);
    try {
      const at = new Date();
      const appendix = withTranscripts ? await transcripts(media) : [];
      download(exportFileName(roomName, at), notesToMarkdown(editor.state.doc, { roomName, at, appendix }));
      setOpen(false);
    } catch {
      setError("The notes could not be exported. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gdoc-export-wrap" ref={wrap}>
      <button
        type="button"
        className="gdoc-add gdoc-export"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={menuId}
        disabled={!editor}
        onClick={() => setOpen((value) => !value)}
      >
        Export
      </button>
      {open && (
        <div className="gdoc-export-menu" id={menuId} role="group" aria-label="Export the notes">
          <button type="button" className="gdoc-export-item" onClick={markdown} disabled={busy}>
            <span className="gdoc-export-title">{busy ? "Preparing…" : "Download Markdown"}</span>
            <span className="gdoc-export-detail">A .md file for Obsidian, Notion, GitHub or any editor</span>
          </button>
          {hasTranscripts && (
            <label className="gdoc-export-option">
              <input type="checkbox" checked={withTranscripts} onChange={(event) => setWithTranscripts(event.target.checked)} />
              Include full transcripts at the end
            </label>
          )}
          <button
            type="button"
            className="gdoc-export-item"
            onClick={() => {
              setOpen(false);
              if (editor) printNotes(editor, roomName);
            }}
          >
            <span className="gdoc-export-title">Print or save as PDF</span>
            <span className="gdoc-export-detail">Opens the print dialog; choose “Save as PDF” there</span>
          </button>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
