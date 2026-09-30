import { EMBEDDING_DIMENSIONS } from "@rmcollab/shared";
import { nanoid } from "nanoid";
import { pool } from "../db/pool.js";
import { splitPassages } from "./passages.js";

/** A passage waiting for its embedding. */
export interface PassageText {
  id: string;
  text: string;
}

/**
 * Splits searchable documents that have not been split yet, and returns the
 * passages that still need embedding. Safe on every replica at once: the
 * passage insert ignores conflicts and returns only what it inserted, so each
 * passage is embedded once however many replicas raced to split it.
 */
export async function splitPending(options: { jobId?: string; limit?: number } = {}): Promise<PassageText[]> {
  const { rows } = await pool.query<{ id: string; kind: string; body: string }>(
    `SELECT id, kind, body FROM job_artifacts
     WHERE passages_at IS NULL AND body IS NOT NULL ${options.jobId ? "AND job_id = $2" : ""}
     ORDER BY created_at
     LIMIT $1`,
    options.jobId ? [options.limit ?? 50, options.jobId] : [options.limit ?? 50],
  );
  const created: PassageText[] = [];
  const now = Date.now();
  for (const artifact of rows) {
    const passages = splitPassages(artifact.kind, artifact.body);
    if (passages.length > 0) {
      const values: unknown[] = [];
      const tuples = passages.map((passage, ord) => {
        const base = ord * 6;
        values.push(nanoid(16), artifact.id, ord, passage.body, passage.startS, now);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
      });
      const inserted = await pool.query<{ id: string; body: string }>(
        `INSERT INTO artifact_passages (id, artifact_id, ord, body, start_s, created_at)
         VALUES ${tuples.join(", ")}
         ON CONFLICT (artifact_id, ord) DO NOTHING
         RETURNING id, body`,
        values,
      );
      created.push(...inserted.rows.map((row) => ({ id: row.id, text: row.body })));
    }
    await pool.query(`UPDATE job_artifacts SET passages_at = $2 WHERE id = $1 AND passages_at IS NULL`, [artifact.id, now]);
  }
  return created;
}

/** Passages still without a vector: after a restart, or an embedding that failed. */
export async function unembedded(limit: number, olderThanMs = 0): Promise<PassageText[]> {
  const { rows } = await pool.query<{ id: string; body: string }>(
    `SELECT id, body FROM artifact_passages
     WHERE embedding IS NULL AND created_at <= $2
     ORDER BY created_at
     LIMIT $1`,
    [limit, Date.now() - olderThanMs],
  );
  return rows.map((row) => ({ id: row.id, text: row.body }));
}

/** pgvector's text form. */
export const toVectorLiteral = (vector: ArrayLike<number>): string => `[${Array.from(vector).join(",")}]`;

/** base64 little-endian float32s (EmbeddedVector.vector) to numbers. */
export function decodeVector(encoded: string): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  // Copied into a fresh buffer: a Float32Array view needs 4-byte alignment,
  // which a slice of Node's pooled buffer does not promise.
  const vector = new Float32Array(new Uint8Array(bytes).buffer);
  if (vector.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`expected a ${EMBEDDING_DIMENSIONS}-dimension vector, got ${vector.length}`);
  }
  return vector;
}

export async function storeEmbeddings(vectors: { id: string; vector: Float32Array }[]): Promise<number> {
  if (vectors.length === 0) return 0;
  const result = await pool.query(
    `UPDATE artifact_passages p SET embedding = v.embedding::vector
     FROM unnest($1::text[], $2::text[]) AS v(id, embedding)
     WHERE p.id = v.id`,
    [vectors.map((v) => v.id), vectors.map((v) => toVectorLiteral(v.vector))],
  );
  return result.rowCount ?? 0;
}

// --- retrieval -------------------------------------------------------------------

export interface NotesCandidate {
  key: string;
  title: string;
  text: string;
  /** Empty when the worker could not embed it; it can still match on keywords. */
  vector: Float32Array | null;
}

export interface Retrieved {
  /** "p:<passage id>" or "n:<notes key>". */
  id: string;
  score: number;
  body: string;
  kind: "transcript" | "summary" | "document" | "notes";
  title: string;
  mediaItemId: string | null;
  mediaType: string | null;
  artifactId: string | null;
  startS: number | null;
  notesKey: string | null;
}

/** How deep each ranking goes before they are merged. */
const DEPTH = 20;
/** Reciprocal-rank-fusion constant: the usual 60, which damps any one list's top ranks. */
const RRF_K = 60;
/**
 * How much a keyword rank counts against a meaning rank. Measured on
 * e2e/fixtures/ask-eval.json (21 questions, including exact identifiers like a
 * command name and a course code): meaning alone ranked the answer first for
 * 0.90 and in the top three for 1.00; weighting keywords at 0.3 to 1 dropped
 * that to 0.81 / 0.90, because a common word ("load") drags in passages that
 * share it ("load balancer"). So keywords only break near-ties and stand in
 * for passages whose embedding has not arrived yet: at 0.01 a keyword rank is
 * worth less than one step in the meaning ranking (1/61 - 1/62).
 */
export const KEYWORD_WEIGHT = (() => {
  const value = Number(process.env.ASK_KEYWORD_WEIGHT);
  return process.env.ASK_KEYWORD_WEIGHT && Number.isFinite(value) && value >= 0 ? value : 0.01;
})();

/**
 * A question's words, joined with "or" for websearch_to_tsquery: a question
 * is not a query, and requiring every word of it would match almost nothing.
 * The parser still drops stop words and stems what is left, and it never
 * rejects input, so nothing typed can break the query.
 */
export function keywordQuery(question: string): string {
  const words = question.match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) ?? [];
  return words.join(" or ");
}

/**
 * Retrieval over one room: the room's document passages and its notes
 * sections, ranked twice - by meaning (cosine distance between embeddings) and
 * by keywords (Postgres full text) - and merged by weighted reciprocal rank
 * fusion. Meaning does the work (see KEYWORD_WEIGHT for the measurement);
 * keywords settle near-ties and keep a passage findable before its embedding
 * lands. Fusion compares ranks, not the two scores, which live on different
 * scales.
 *
 * Every question is scoped to a room of at most a few hundred passages, so the
 * vector ranking is an exact scan rather than an approximate index.
 */
export async function retrieve(
  roomId: string,
  question: string,
  questionVector: Float32Array,
  notes: NotesCandidate[],
  limit: number,
): Promise<Retrieved[]> {
  const { rows } = await pool.query<{
    cid: string;
    score: number;
    body: string;
    artifact_kind: string | null;
    artifact_id: string | null;
    label: string | null;
    start_s: number | null;
    media_item_id: string | null;
    media_type: string | null;
    title: string | null;
    notes_key: string | null;
  }>(
    `WITH q AS (
       SELECT $2::vector AS v, websearch_to_tsquery('english', $3) AS tsq
     ),
     room_passages AS (
       SELECT p.id, p.body, p.start_s, p.embedding, p.search,
              a.id AS artifact_id, a.kind AS artifact_kind, a.label,
              m.id AS media_item_id, m.media_type,
              coalesce(nullif(btrim(m.title), ''), m.original_filename,
                       CASE m.media_type WHEN 'audio' THEN 'Recording' WHEN 'video' THEN 'Video'
                                         WHEN 'image' THEN 'Image' ELSE 'Text' END || ' from ' || u.display_name) AS title
       FROM artifact_passages p
       JOIN job_artifacts a ON a.id = p.artifact_id
       JOIN enhancement_jobs j ON j.id = a.job_id
       JOIN media_items m ON m.id = j.media_item_id
       JOIN participants u ON u.id = m.uploader_id
       WHERE m.room_id = $1
     ),
     notes AS (
       SELECT n.key, n.title, n.body,
              nullif(n.embedding, '')::vector AS embedding,
              to_tsvector('english', n.title || ' ' || n.body) AS search
       FROM unnest($4::text[], $5::text[], $6::text[], $7::text[]) AS n(key, title, body, embedding)
     ),
     candidates AS (
       SELECT 'p:' || id AS cid, embedding, search FROM room_passages
       UNION ALL
       SELECT 'n:' || key, embedding, search FROM notes
     ),
     by_meaning AS (
       SELECT cid, row_number() OVER (ORDER BY embedding <=> q.v) AS r, 1.0 AS w
       FROM candidates, q
       WHERE embedding IS NOT NULL
       ORDER BY embedding <=> q.v
       LIMIT ${DEPTH}
     ),
     by_keywords AS (
       SELECT cid, row_number() OVER (ORDER BY ts_rank_cd(search, q.tsq) DESC) AS r, ${KEYWORD_WEIGHT}::float8 AS w
       FROM candidates, q
       WHERE search @@ q.tsq
       ORDER BY ts_rank_cd(search, q.tsq) DESC
       LIMIT ${DEPTH}
     ),
     fused AS (
       SELECT cid, sum(w / (${RRF_K} + r))::float8 AS score
       FROM (SELECT * FROM by_meaning UNION ALL SELECT * FROM by_keywords) ranked
       GROUP BY cid
       ORDER BY score DESC
       LIMIT $8
     )
     SELECT f.cid, f.score,
            coalesce(rp.body, n.body) AS body,
            rp.artifact_kind, rp.artifact_id, rp.label, rp.start_s,
            rp.media_item_id, rp.media_type,
            coalesce(rp.title, n.title) AS title,
            n.key AS notes_key
     FROM fused f
     LEFT JOIN room_passages rp ON f.cid = 'p:' || rp.id
     LEFT JOIN notes n ON f.cid = 'n:' || n.key
     ORDER BY f.score DESC`,
    [
      roomId,
      toVectorLiteral(questionVector),
      keywordQuery(question),
      notes.map((n) => n.key),
      notes.map((n) => n.title),
      notes.map((n) => n.text),
      notes.map((n) => (n.vector ? toVectorLiteral(n.vector) : "")),
      limit,
    ],
  );

  return rows.map((row) => ({
    id: row.cid,
    score: row.score,
    body: row.body,
    kind: row.notes_key
      ? "notes"
      : row.artifact_kind === "transcript"
        ? "transcript"
        : row.artifact_kind === "summary"
          ? "summary"
          : "document",
    title: row.title ?? row.label ?? "Untitled",
    mediaItemId: row.media_item_id,
    mediaType: row.media_type,
    artifactId: row.artifact_id,
    startS: row.start_s,
    notesKey: row.notes_key,
  }));
}
