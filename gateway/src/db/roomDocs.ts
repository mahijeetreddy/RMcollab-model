import { pool } from "./pool.js";

/** Snapshot (if any) followed by every update since it; apply in any order. */
export async function loadRoomDocParts(roomId: string): Promise<Uint8Array[]> {
  const { rows } = await pool.query<{ data: Buffer }>(
    `SELECT snapshot AS data FROM room_docs WHERE room_id = $1
     UNION ALL
     SELECT data FROM (
       SELECT data, seq FROM room_doc_updates WHERE room_id = $1 ORDER BY seq
     ) u`,
    [roomId],
  );
  return rows.map((row) => new Uint8Array(row.data));
}

/** Appends one merged batch; returns how many updates now sit uncompacted. */
export async function appendRoomDocUpdate(roomId: string, update: Uint8Array): Promise<number> {
  const { rows } = await pool.query<{ pending: string }>(
    `WITH inserted AS (
       INSERT INTO room_doc_updates (room_id, data, created_at) VALUES ($1, $2, $3) RETURNING 1
     )
     SELECT (SELECT count(*) FROM room_doc_updates WHERE room_id = $1) + 1 AS pending`,
    [roomId, Buffer.from(update), Date.now()],
  );
  return Number(rows[0]?.pending ?? 0);
}

/**
 * Folds the update log into the snapshot. Runs entirely against the database,
 * not a replica's in-memory document, so it is correct even if this replica
 * has not seen every update. A transaction-scoped advisory lock keeps two
 * replicas from compacting the same room at once; the loser just skips.
 */
export async function compactRoomDoc(
  roomId: string,
  merge: (parts: Uint8Array[]) => Uint8Array,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: lock } = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtext('room_doc:' || $1)) AS ok",
      [roomId],
    );
    if (!lock[0]?.ok) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: updates } = await client.query<{ seq: string; data: Buffer }>(
      "SELECT seq, data FROM room_doc_updates WHERE room_id = $1 ORDER BY seq",
      [roomId],
    );
    if (updates.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows: snap } = await client.query<{ snapshot: Buffer }>(
      "SELECT snapshot FROM room_docs WHERE room_id = $1 FOR UPDATE",
      [roomId],
    );
    const parts = [
      ...(snap[0] ? [new Uint8Array(snap[0].snapshot)] : []),
      ...updates.map((u) => new Uint8Array(u.data)),
    ];
    const watermark = updates[updates.length - 1]!.seq;
    await client.query(
      `INSERT INTO room_docs (room_id, snapshot, compacted_seq, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (room_id) DO UPDATE SET snapshot = $2, compacted_seq = $3, updated_at = $4`,
      [roomId, Buffer.from(merge(parts)), watermark, Date.now()],
    );
    // Exactly the rows merged, never "seq <= watermark": a sequence value is
    // taken at insert but visible only at commit, so another replica's batch
    // can hold a lower seq and still have been invisible to the read above.
    // Deleting by range would drop an edit that was never merged.
    await client.query("DELETE FROM room_doc_updates WHERE room_id = $1 AND seq = ANY($2::bigint[])", [
      roomId,
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
