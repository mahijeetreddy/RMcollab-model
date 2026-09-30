import type { AskSource } from "@rmcollab/shared";

/**
 * A citation in the shared notes, as a link that points back at its source.
 * The link lives in the document, so it works for everyone in the room and
 * survives reloads - not just for whoever asked. It is an in-page fragment,
 * which the editor's link rules accept and no browser navigates away on; the
 * notes editor intercepts the click and opens the source in the app.
 */

/** Everything needed to open a source: what AskSource carries, less its text. */
export type SourceTarget = Pick<AskSource, "kind" | "mediaItemId" | "artifactId" | "atSeconds" | "notesKey"> & {
  /** Which of the room's documents a notes source is in. */
  docId?: string | null;
};

export const SOURCE_LINK_PREFIX = "#rmc-source?";

const KINDS: readonly SourceTarget["kind"][] = ["transcript", "summary", "document", "notes"];
// Ids are nanoids; notes keys are "u:<id>", "h:<n>" or "top". Anything else in a
// link someone pasted is ignored rather than trusted.
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const NOTES_KEY = /^(top|h:\d{1,4}|u:[A-Za-z0-9_-]{1,64})$/;

export function sourceHref(source: SourceTarget): string {
  const params = new URLSearchParams({ k: source.kind });
  if (source.mediaItemId) params.set("m", source.mediaItemId);
  if (source.artifactId) params.set("a", source.artifactId);
  if (source.atSeconds !== null) params.set("t", String(Math.max(0, Math.floor(source.atSeconds))));
  if (source.notesKey) params.set("n", source.notesKey);
  if (source.docId) params.set("d", source.docId);
  return SOURCE_LINK_PREFIX + params.toString();
}

export const isSourceHref = (href: string | null | undefined): boolean => Boolean(href?.startsWith(SOURCE_LINK_PREFIX));

export function parseSourceHref(href: string | null | undefined): SourceTarget | null {
  if (!href || !isSourceHref(href)) return null;
  const params = new URLSearchParams(href.slice(SOURCE_LINK_PREFIX.length));
  const kind = params.get("k") as SourceTarget["kind"] | null;
  if (!kind || !KINDS.includes(kind)) return null;
  const mediaItemId = params.get("m");
  const artifactId = params.get("a");
  const notesKey = params.get("n");
  const docId = params.get("d");
  const t = params.get("t");
  if (docId !== null && docId !== "main" && !/^[A-Za-z0-9_-]{8,32}$/.test(docId)) return null;
  if (mediaItemId !== null && !ID.test(mediaItemId)) return null;
  if (artifactId !== null && !ID.test(artifactId)) return null;
  if (notesKey !== null && !NOTES_KEY.test(notesKey)) return null;
  const atSeconds = t !== null && /^\d{1,6}$/.test(t) ? Number(t) : null;
  // A link that points nowhere is not a link.
  if (!mediaItemId && !notesKey) return null;
  return { kind, mediaItemId, artifactId, atSeconds, notesKey, ...(docId ? { docId } : {}) };
}
