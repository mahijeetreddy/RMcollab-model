import type { MediaType } from "@rmcollab/shared";

/**
 * What a dropped file or a piece of pasted text is, worked out in the browser
 * before anything is uploaded, so the room can be offered the right action
 * instead of a menu of algorithms.
 *
 * The gateway re-checks the actual bytes on upload: this is for the proposal,
 * not for trust.
 */

/** Mirrors the gateway's MAX_UPLOAD_BYTES default; it rejects anything larger. */
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;

export interface Detected {
  kind: MediaType;
  /** Human size of what was measured, e.g. "42 min" or "1600×1000". */
  summary: string;
  words?: number;
  width?: number;
  height?: number;
  durationS?: number;
  sizeBytes?: number;
  /** Set when the item cannot be used as it is; the UI says why. */
  problem?: string;
  /** Not a kind the room takes at all; `kind` is then only a placeholder. */
  unknown?: boolean;
}

const EXTENSIONS: Record<string, MediaType> = {
  txt: "text", md: "text", markdown: "text", csv: "text",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", bmp: "image",
  mp3: "audio", wav: "audio", m4a: "audio", ogg: "audio", oga: "audio", flac: "audio", aac: "audio", weba: "audio", opus: "audio",
  mp4: "video", mov: "video", webm: "video", mkv: "video", m4v: "video", avi: "video",
};

/** The media kind from a MIME type, falling back to the file extension. */
export function classify(name: string, mimeType: string): MediaType | null {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/") || mime === "application/json") return "text";
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return EXTENSIONS[ext] ?? null;
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function detectText(text: string): Detected {
  const words = countWords(text);
  return { kind: "text", words, summary: `${words.toLocaleString()} ${words === 1 ? "word" : "words"}` };
}

// --- measuring files (browser only) ----------------------------------------------

const PROBE_TIMEOUT_MS = 5000;

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), PROBE_TIMEOUT_MS))]);
}

function mediaDuration(file: File, kind: "audio" | "video"): Promise<number | null> {
  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = "metadata";
  const done = new Promise<number | null>((resolve) => {
    element.onloadedmetadata = () => resolve(Number.isFinite(element.duration) ? element.duration : null);
    element.onerror = () => resolve(null);
  });
  element.src = url;
  return withTimeout(done).finally(() => {
    element.removeAttribute("src");
    URL.revokeObjectURL(url);
  });
}

function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  const url = URL.createObjectURL(file);
  const image = new Image();
  const done = new Promise<{ width: number; height: number } | null>((resolve) => {
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(null);
  });
  image.src = url;
  return withTimeout(done).finally(() => URL.revokeObjectURL(url));
}

/** Classifies a file and measures what the browser can measure cheaply. */
export async function detectFile(file: File): Promise<Detected> {
  const kind = classify(file.name, file.type);
  const size = formatSize(file.size);
  if (!kind) {
    return { kind: "text", unknown: true, summary: size, sizeBytes: file.size, problem: "This kind of file can't be added. Try text, an image, a recording or a video." };
  }
  const base: Detected = { kind, summary: size, sizeBytes: file.size };
  if (file.size > MAX_UPLOAD_BYTES) {
    return { ...base, problem: `${size} is over the ${formatSize(MAX_UPLOAD_BYTES)} upload limit.` };
  }
  if (kind === "text") {
    const text = await file.text();
    return { ...detectText(text), sizeBytes: file.size };
  }
  if (kind === "image") {
    const dims = await imageSize(file);
    return dims ? { ...base, ...dims, summary: `${dims.width}×${dims.height}` } : base;
  }
  const durationS = await mediaDuration(file, kind);
  return durationS ? { ...base, durationS, summary: formatDuration(durationS) } : base;
}
