import type { MediaType } from "@rmcollab/shared";

/**
 * A message's time, with its day once it is not today: sessions can last a
 * month, and "10:30" on last Tuesday's message read as this morning.
 * "10:30", "Yesterday 10:30", "Mon 10:30" within the week, then "12 Sep, 10:30".
 */
export function formatTime(timestamp: number, now = Date.now()): string {
  const at = new Date(timestamp);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(new Date(now)) - startOf(at)) / 86_400_000);
  if (days <= 0) return time;
  if (days === 1) return `Yesterday ${time}`;
  if (days < 7) return `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${at.toLocaleDateString([], { day: "numeric", month: "short" })}, ${time}`;
}

/** Plain text in pieces, with http(s) links found in it - for chat, where pasted links were dead text. */
export function linkParts(text: string): { text: string; href?: string }[] {
  const parts: { text: string; href?: string }[] = [];
  const url = /\bhttps?:\/\/[^\s<>"']+/gi;
  let last = 0;
  for (const match of text.matchAll(url)) {
    // Trailing punctuation is the sentence's, not the link's.
    const href = match[0].replace(/[.,;:!?)\]]+$/, "");
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: href, href });
    last = start + href.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes)) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + second).toUpperCase();
}

export const MEDIA_TYPES: readonly MediaType[] = ["text", "image", "audio", "video"] as const;

export const MEDIA_TYPE_LABELS: Record<MediaType, string> = {
  text: "Text",
  image: "Image",
  audio: "Audio",
  video: "Video",
};

export const FILE_ACCEPT: Record<MediaType, string> = {
  text: "text/plain",
  image: "image/*",
  audio: "audio/*",
  video: "video/*",
};
