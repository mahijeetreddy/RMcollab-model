import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface StorageAdapter {
  save(relPath: string, data: Buffer): Promise<void>;
  /** Absolute on-disk path; throws if relPath escapes the storage root. */
  resolve(relPath: string): string;
  publicUrl(relPath: string): string;
}

const root = path.resolve(config.storageRoot);

class LocalStorage implements StorageAdapter {
  resolve(relPath: string): string {
    const normalized = path.posix.normalize(relPath.replace(/\\/g, "/")).replace(/^\/+/, "");
    const absolute = path.resolve(root, normalized);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`path escapes storage root: ${relPath}`);
    }
    return absolute;
  }

  async save(relPath: string, data: Buffer): Promise<void> {
    const absolute = this.resolve(relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, data);
  }

  publicUrl(relPath: string): string {
    const clean = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
    const encoded = clean.split("/").map(encodeURIComponent).join("/");
    const expires = Math.floor(Date.now() / 1000) + config.files.urlTtlSeconds;
    return `${config.publicBaseUrl}/files/${encoded}?exp=${expires}&sig=${signPath(clean, expires)}`;
  }
}

function signPath(cleanPath: string, expires: number): string {
  return createHmac("sha256", config.files.signingSecret)
    .update(`${cleanPath}:${expires}`)
    .digest("hex");
}

/**
 * Presigned-URL check. Media URLs are handed to `<img>`/`<video>`, which cannot
 * attach an Authorization header, so possession of a signed, expiring link is
 * what authorises the read — the link itself is only ever sent to members of the
 * room that owns the file.
 */
export function verifyFileSignature(
  cleanPath: string,
  exp: string | undefined,
  sig: string | undefined,
): { ok: true } | { ok: false; reason: "expired" | "invalid" } {
  const expires = Number(exp);
  if (!Number.isFinite(expires) || !sig) return { ok: false, reason: "invalid" };
  if (expires < Math.floor(Date.now() / 1000)) return { ok: false, reason: "expired" };

  const expected = Buffer.from(signPath(cleanPath, expires));
  const actual = Buffer.from(sig);
  const valid = expected.length === actual.length && timingSafeEqual(expected, actual);
  return valid ? { ok: true } : { ok: false, reason: "invalid" };
}

export const storage: StorageAdapter = new LocalStorage();

export const originalPath = (roomId: string, mediaItemId: string, ext: string): string =>
  `rooms/${roomId}/${mediaItemId}/original.${ext}`;

export const enhancedPath = (roomId: string, mediaItemId: string, ext: string): string =>
  `rooms/${roomId}/${mediaItemId}/enhanced.${ext}`;
