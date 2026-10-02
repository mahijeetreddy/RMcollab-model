import { createHmac, timingSafeEqual } from "node:crypto";
import { copyFile, mkdir, open, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";

export interface StorageAdapter {
  save(relPath: string, data: Buffer): Promise<void>;
  /** Moves a file already on disk (an upload streamed to a temp file) to `relPath`. */
  moveIn(absoluteSource: string, relPath: string): Promise<void>;
  /** Absolute on-disk path; throws if relPath escapes the storage root. */
  resolve(relPath: string): string;
  publicUrl(relPath: string): string;
  /** Up to `maxBytes` of a stored file as UTF-8, or null if it cannot be read. */
  readText(relPath: string, maxBytes: number): Promise<string | null>;
  /** Deletes a folder and everything in it; a missing folder is not an error. */
  removeTree(relPath: string): Promise<void>;
  /** The names of the folders directly inside `relPath`. */
  listDirs(relPath: string): Promise<string[]>;
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

  async moveIn(absoluteSource: string, relPath: string): Promise<void> {
    const absolute = this.resolve(relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    try {
      await rename(absoluteSource, absolute);
    } catch (err) {
      // Another filesystem (a temp dir on a different volume): copy, then remove.
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(absoluteSource, absolute);
      await unlink(absoluteSource);
    }
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

  async removeTree(relPath: string): Promise<void> {
    const absolute = this.resolve(relPath);
    // Never the root itself, whatever relPath normalised to.
    if (absolute === root) throw new Error("refusing to remove the storage root");
    await rm(absolute, { recursive: true, force: true });
  }

  async listDirs(relPath: string): Promise<string[]> {
    try {
      const entries = await readdir(this.resolve(relPath), { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
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

/**
 * Where uploads stream while they arrive, inside the storage root so that
 * moving one into place is a rename. Not under rooms/, so the orphan sweep
 * never mistakes an upload in progress for something left behind.
 */
export const uploadTempDir = path.join(root, "tmp", "uploads");

/** The first `bytes` of a file on disk: enough to tell what it is. */
export async function readHead(absolute: string, bytes: number): Promise<Buffer> {
  const handle = await open(absolute, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Temp uploads older than `maxAgeMs`: a crash or a dropped connection left them. */
export async function sweepUploadTemp(maxAgeMs: number, now = Date.now()): Promise<number> {
  let removed = 0;
  let names: string[] = [];
  try {
    names = await readdir(uploadTempDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = path.join(uploadTempDir, name);
    try {
      if (now - (await stat(file)).mtimeMs > maxAgeMs) {
        await rm(file, { force: true });
        removed += 1;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}

export const originalPath = (roomId: string, mediaItemId: string, ext: string): string =>
  `rooms/${roomId}/${mediaItemId}/original.${ext}`;

export const enhancedPath = (roomId: string, mediaItemId: string, ext: string): string =>
  `rooms/${roomId}/${mediaItemId}/enhanced.${ext}`;

/** Everything one upload stored: its original, results and working files. */
export const mediaFolder = (roomId: string, mediaItemId: string): string => `rooms/${roomId}/${mediaItemId}`;
export const roomFolder = (roomId: string): string => `rooms/${roomId}`;
