import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface StorageAdapter {
  save(relPath: string, data: Buffer): Promise<void>;
  /** Absolute on-disk path; throws if relPath escapes the storage root. */
  resolve(relPath: string): string;
  publicUrl(relPath: string): string;
  /** Up to `maxBytes` of a stored file as UTF-8, or null if it cannot be read. */
  readText(relPath: string, maxBytes: number): Promise<string | null>;
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

  async readText(relPath: string, maxBytes: number): Promise<string | null> {
    let handle;
    try {
      handle = await open(this.resolve(relPath), "r");
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      // A cut can land inside a multi-byte character; the decoder turns that
      // tail into U+FFFD, which is dropped rather than indexed.
      return buffer.subarray(0, bytesRead).toString("utf8").replace(/\uFFFD+$/, "");
    } catch {
      return null;
    } finally {
      await handle?.close();
    }
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
