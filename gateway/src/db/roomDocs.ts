import { MAIN_DOC_ID, parseDocKey } from "@rmcollab/shared/notes";
import type { RoomDocument } from "@rmcollab/shared";
import { nanoid } from "nanoid";
import { pool } from "./pool.js";

/**
 * Storage for a room's documents. Functions take a document key (see docKey
 * in the shared package): the main document's is the room id, any other's is
 * `<roomId>:<docId>`. The hub treats keys as opaque; only this layer splits them.
 */

/** Snapshot (if any) followed by every update since it; apply in any order. */
export async function loadRoomDocParts(key: string): Promise<Uint8Array[]> {
  const { roomId, docId } = parseDocKey(key);
  const { rows } = await pool.query<{ data: Buffer }>(
    `SELECT snapshot AS data FROM room_docs WHERE room_id = $1 AND doc_id = $2
     UNION ALL
     SELECT data FROM (
       SELECT data, seq FROM room_doc_updates WHERE room_id = $1 AND doc_id = $2 ORDER BY seq
     ) u`,
    [roomId, docId],
  );
  return rows.map((row) => new Uint8Array(row.data));
}

/** Appends one merged batch; returns how many updates now sit uncompacted. */
export async function appendRoomDocUpdate(key: string, update: Uint8Array): Promise<number> {
  const { roomId, docId } = parseDocKey(key);
  const now = Date.now();
  const { rows } = await pool.query<{ pending: string }>(
    `WITH inserted AS (
       INSERT INTO room_doc_updates (room_id, doc_id, data, created_at) VALUES ($1, $2, $3, $4) RETURNING 1
     ), touched AS (
       UPDATE room_documents SET updated_at = $4 WHERE room_id = $1 AND id = $2 RETURNING 1
     )
     SELECT (SELECT count(*) FROM room_doc_updates WHERE room_id = $1 AND doc_id = $2) + 1 AS pending`,
    [roomId, docId, Buffer.from(update), now],
  );
  return Number(rows[0]?.pending ?? 0);
}

/**
 * Folds the update log into the snapshot. Runs entirely against the database,
 * not a replica's in-memory document, so it is correct even if this replica
 * has not seen every update. A transaction-scoped advisory lock keeps two
 * replicas from compacting the same document at once; the loser just skips.
 */
export async function compactRoomDoc(key: string, merge: (parts: Uint8Array[]) => Uint8Array): Promise<boolean> {
  const { roomId, docId } = parseDocKey(key);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: lock } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('room_doc:' || $1)) AS ok",
      [key],
    );
    if (!lock[0]?.ok) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: updates } = await client.query<{ seq: string; data: Buffer }>(
      "SELECT seq, data FROM room_doc_updates WHERE room_id = $1 AND doc_id = $2 ORDER BY seq",
      [roomId, docId],
    );
    if (updates.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: snap } = await client.query<{ snapshot: Buffer }>(
      "SELECT snapshot FROM room_docs WHERE room_id = $1 AND doc_id = $2 FOR UPDATE",
      [roomId, docId],
    );
    const parts = [...(snap[0] ? [new Uint8Array(snap[0].snapshot)] : []), ...updates.map((u) => new Uint8Array(u.data))];
    const watermark = updates[updates.length - 1]!.seq;
    await client.query(
      `INSERT INTO room_docs (room_id, doc_id, snapshot, compacted_seq, updated_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (room_id, doc_id) DO UPDATE SET snapshot = $3, compacted_seq = $4, updated_at = $5`,
      [roomId, docId, Buffer.from(merge(parts)), watermark, Date.now()],
    );
    // Exactly the rows merged, never "seq <= watermark": a sequence value is
    // taken at insert but visible only at commit, so another replica's batch
    // can hold a lower seq and still have been invisible to the read above.
    // Deleting by range would drop an edit that was never merged.
    await client.query("DELETE FROM room_doc_updates WHERE room_id = $1 AND doc_id = $2 AND seq = ANY($3::bigint[])", [
      roomId,
      docId,
      updates.map((u) => u.seq),
    ]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// --- versions: restore points for a document ----------------------------------------

/** How many restore points a document keeps; older ones are dropped as new ones arrive. */
export const MAX_VERSIONS = 50;

export interface VersionRow {
  id: string;
  createdAt: number;
  reason: string;
  words: number;
}

export async function saveRoomDocVersion(key: string, state: Uint8Array, reason: string, words: number): Promise<string> {
  const { roomId, docId } = parseDocKey(key);
  const id = nanoid(16);
  await pool.query(
    `INSERT INTO room_doc_versions (id, room_id, doc_id, created_at, reason, words, state) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, roomId, docId, Date.now(), reason, words, Buffer.from(state)],
  );
  await pool.query(
    `DELETE FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2 AND id NOT IN (
       SELECT id FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2 ORDER BY created_at DESC LIMIT $3)`,
    [roomId, docId, MAX_VERSIONS],
  );
  return id;
}

export async function latestRoomDocVersionAt(key: string): Promise<number | null> {
  const { roomId, docId } = parseDocKey(key);
  const { rows } = await pool.query<{ created_at: string }>(
    `SELECT created_at FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2 ORDER BY created_at DESC LIMIT 1`,
    [roomId, docId],
  );
  return rows[0] ? Number(rows[0].created_at) : null;
}

export async function listRoomDocVersions(key: string): Promise<VersionRow[]> {
  const { roomId, docId } = parseDocKey(key);
  const { rows } = await pool.query<{ id: string; created_at: string; reason: string; words: number }>(
    `SELECT id, created_at, reason, words FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2 ORDER BY created_at DESC`,
    [roomId, docId],
  );
  return rows.map((r) => ({ id: r.id, createdAt: Number(r.created_at), reason: r.reason, words: r.words }));
}

export async function getRoomDocVersion(key: string, id: string): Promise<(VersionRow & { state: Uint8Array }) | null> {
  const { roomId, docId } = parseDocKey(key);
  const { rows } = await pool.query<{ id: string; created_at: string; reason: string; words: number; state: Buffer }>(
    `SELECT id, created_at, reason, words, state FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2 AND id = $3`,
    [roomId, docId, id],
  );
  const r = rows[0];
  return r ? { id: r.id, createdAt: Number(r.created_at), reason: r.reason, words: r.words, state: new Uint8Array(r.state) } : null;
}

// --- the documents themselves --------------------------------------------------------

/** What the main document is called. */
export const MAIN_DOC_TITLE = "Room notes";
/** Enough for any study group; a cap keeps one room from filling the database. */
export const MAX_DOCUMENTS_PER_ROOM = 50;

interface DocumentRow {
  room_id: string;
  id: string;
  title: string;
  is_main: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
}

const toDocument = (r: DocumentRow): RoomDocument => ({
  id: r.id,
  roomId: r.room_id,
  title: r.title,
  isMain: r.is_main,
  createdBy: r.created_by,
  createdByName: r.created_by_name,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** A room's documents, its notes first, then most recently edited. The main one is made if missing. */
export async function listDocuments(roomId: string): Promise<RoomDocument[]> {
  const now = Date.now();
  await pool.query(
    `INSERT INTO room_documents (room_id, id, title, is_main, created_at, updated_at)
     SELECT $1, $2, $3, TRUE, $4,
            coalesce((SELECT updated_at FROM room_docs WHERE room_id = $1 AND doc_id = $2), $4)
     WHERE EXISTS (SELECT 1 FROM rooms WHERE id = $1)
     ON CONFLICT DO NOTHING`,
    [roomId, MAIN_DOC_ID, MAIN_DOC_TITLE, now],
  );
  const { rows } = await pool.query<DocumentRow>(
    `SELECT d.*, p.display_name AS created_by_name
     FROM room_documents d LEFT JOIN participants p ON p.id = d.created_by
     WHERE d.room_id = $1
     ORDER BY d.is_main DESC, d.updated_at DESC`,
    [roomId],
  );
  return rows.map(toDocument);
}

export async function getDocument(roomId: string, docId: string): Promise<RoomDocument | null> {
  return (await listDocuments(roomId)).find((d) => d.id === docId) ?? null;
}

/** A new, empty document; null when the room already holds as many as it may. */
export async function createDocument(roomId: string, title: string, createdBy: string): Promise<RoomDocument | null> {
  const { rows: count } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM room_documents WHERE room_id = $1`, [roomId]);
  if (Number(count[0]?.n ?? 0) >= MAX_DOCUMENTS_PER_ROOM) return null;
  const now = Date.now();
  const id = nanoid(12);
  await pool.query(
    `INSERT INTO room_documents (room_id, id, title, is_main, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, FALSE, $4, $5, $5)`,
    [roomId, id, title, createdBy, now],
  );
  return getDocument(roomId, id);
}

export async function renameDocument(roomId: string, docId: string, title: string): Promise<void> {
  await pool.query(`UPDATE room_documents SET title = $3 WHERE room_id = $1 AND id = $2 AND NOT is_main`, [roomId, docId, title]);
}

/** Deletes a document with its content and history. The main one cannot be deleted. */
export async function deleteDocument(roomId: string, docId: string): Promise<boolean> {
  if (docId === MAIN_DOC_ID) return false;
  const { rowCount } = await pool.query(`DELETE FROM room_documents WHERE room_id = $1 AND id = $2 AND NOT is_main`, [roomId, docId]);
  if (!rowCount) return false;
  await pool.query(`DELETE FROM room_docs WHERE room_id = $1 AND doc_id = $2`, [roomId, docId]);
  await pool.query(`DELETE FROM room_doc_updates WHERE room_id = $1 AND doc_id = $2`, [roomId, docId]);
  await pool.query(`DELETE FROM room_doc_versions WHERE room_id = $1 AND doc_id = $2`, [roomId, docId]);
  return true;
}
