import type { MediaType } from "@rmcollab/shared";

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
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
