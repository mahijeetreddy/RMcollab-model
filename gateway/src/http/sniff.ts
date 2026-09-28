import type { MediaType } from "@rmcollab/shared";

/**
 * What an uploaded file actually is, from its first bytes rather than from the
 * type the browser claimed. The media type decides which worker pool gets the
 * job, so a renamed or mislabelled file used to be routed to the wrong pool and
 * stored under the wrong extension.
 *
 * Some containers cannot say audio or video from a signature alone - an MP4 or
 * a WebM may hold either - so a sniff gives the kinds it allows, and the
 * declared type is accepted when it is one of them.
 */
export interface Sniffed {
  /** Every media kind the content is consistent with, most likely first. */
  kinds: MediaType[];
  mime: string;
  ext: string;
}

const ascii = (buf: Buffer, start: number, end: number) => buf.subarray(start, end).toString("latin1");
const startsWith = (buf: Buffer, bytes: number[]) => bytes.every((b, i) => buf[i] === b);

/** Valid UTF-8 with no NUL bytes in the first 8KB reads as text. */
function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.length === 0 || head.includes(0)) return false;
  // A cut can land inside a multi-byte character; trim up to three bytes of it.
  for (let trim = 0; trim <= 3 && trim < head.length; trim += 1) {
    const slice = head.subarray(0, head.length - trim);
    if (!slice.toString("utf8").includes("�")) return true;
  }
  return false;
}

export function sniffMedia(buf: Buffer): Sniffed | null {
  if (buf.length < 4) return looksLikeText(buf) ? { kinds: ["text"], mime: "text/plain", ext: "txt" } : null;

  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kinds: ["image"], mime: "image/png", ext: "png" };
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return { kinds: ["image"], mime: "image/jpeg", ext: "jpg" };
  if (ascii(buf, 0, 6) === "GIF87a" || ascii(buf, 0, 6) === "GIF89a") return { kinds: ["image"], mime: "image/gif", ext: "gif" };
  if (ascii(buf, 0, 2) === "BM" && buf.length > 26) return { kinds: ["image"], mime: "image/bmp", ext: "bmp" };

  if (ascii(buf, 0, 4) === "RIFF" && buf.length >= 12) {
    const form = ascii(buf, 8, 12);
    if (form === "WEBP") return { kinds: ["image"], mime: "image/webp", ext: "webp" };
    if (form === "WAVE") return { kinds: ["audio"], mime: "audio/wav", ext: "wav" };
    if (form === "AVI ") return { kinds: ["video"], mime: "video/x-msvideo", ext: "avi" };
  }

  if (ascii(buf, 0, 3) === "ID3") return { kinds: ["audio"], mime: "audio/mpeg", ext: "mp3" };
  // An MPEG audio frame header: 11 set sync bits.
  if (buf[0] === 0xff && (buf[1]! & 0xe0) === 0xe0) return { kinds: ["audio"], mime: "audio/mpeg", ext: "mp3" };
  if (ascii(buf, 0, 4) === "fLaC") return { kinds: ["audio"], mime: "audio/flac", ext: "flac" };
  if (ascii(buf, 0, 4) === "OggS") return { kinds: ["audio", "video"], mime: "audio/ogg", ext: "ogg" };

  if (buf.length >= 12 && ascii(buf, 4, 8) === "ftyp") {
    const brand = ascii(buf, 8, 12);
    if (brand === "M4A " || brand === "M4B ") return { kinds: ["audio"], mime: "audio/mp4", ext: "m4a" };
    if (brand === "qt  ") return { kinds: ["video"], mime: "video/quicktime", ext: "mov" };
    return { kinds: ["video", "audio"], mime: "video/mp4", ext: "mp4" };
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return { kinds: ["video", "audio"], mime: "video/webm", ext: "webm" };

  if (looksLikeText(buf)) return { kinds: ["text"], mime: "text/plain", ext: "txt" };
  return null;
}

/**
 * The media type to route by: the declared one when the content allows it
 * (an MP4 declared as audio is audio), otherwise what the content says.
 */
export function resolveMediaType(sniffed: Sniffed, declared: MediaType | null): { mediaType: MediaType; overridden: boolean } {
  if (declared && sniffed.kinds.includes(declared)) return { mediaType: declared, overridden: false };
  return { mediaType: sniffed.kinds[0]!, overridden: declared !== null };
}
