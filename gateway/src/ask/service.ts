import {
  askChannel,
  QUEUE_ASK,
  TASK_ASK_ANSWER,
  TASK_ASK_PREPARE,
  type AskAnswerTask,
  type AskFallback,
  type AskHistoryTurn,
  type AskPrepareTask,
  type AskReply,
  type AskSource,
  type ServerEvent,
} from "@rmcollab/shared";
import { docKey, MAIN_DOC_ID, NOTES_FIELD, notesSections } from "@rmcollab/shared/notes";
import { listDocuments } from "../db/roomDocs.js";
import { Redis } from "ioredis";
import { nanoid } from "nanoid";
import { config } from "../config.js";
import { docHub } from "../docs/hub.js";
import { enqueueTask } from "../queue/enqueue.js";
import { splitPassages } from "./passages.js";
import { decodeVector, retrieve, type NotesCandidate, type Retrieved } from "./store.js";

/**
 * Ask the room, one question end to end:
 *
 *   1. the room's notes, as sections, and the question go to a worker to embed
 *   2. the gateway ranks the room's passages and notes against the question
 *   3. the passages go to the client (so citations render as they arrive)
 *      and to a worker, which streams the answer back
 *   4. the finished answer's citations are checked against what was sent
 *
 * Everything goes to the asking socket only: a question is private.
 */

/** Passages handed to the model: enough to answer from, few enough to stay fast. */
export const PASSAGES = 8;
const PREPARE_TIMEOUT_MS = 15_000;
/** A worker that has not started answering by now is not going to. */
const FIRST_WORDS_TIMEOUT_MS = 30_000;
const ANSWER_TIMEOUT_MS = 90_000;
/** Questions a person may ask a minute: each one spends a model call. */
export const ASKS_PER_MINUTE = 6;
const MAX_NOTES_PIECES = 150;
const EXCERPT_CHARS = 280;

/** Replies for requests this replica is waiting on, by channel. */
const listeners = new Map<string, (reply: AskReply) => void>();

// Connected on first use, so importing this module (as the tests do) opens nothing.
let connections: { redis: Redis; subscriber: Redis } | null = null;
function clients(): { redis: Redis; subscriber: Redis } {
  if (connections) return connections;
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const subscriber = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  redis.on("error", (err) => console.error("[ask] redis", err.message));
  subscriber.on("error", (err) => console.error("[ask] subscriber", err.message));
  subscriber.on("message", (channel: string, payload: string) => {
    const listener = listeners.get(channel);
    if (!listener) return;
    try {
      listener(JSON.parse(payload) as AskReply);
    } catch {
      // A malformed reply is ignored; the request times out and says so.
    }
  });
  connections = { redis, subscriber };
  return connections;
}

/** Replies to one request, read in order with a timeout on each wait. */
class Replies {
  private readonly queue: AskReply[] = [];
  private waiting: ((reply: AskReply | null) => void) | null = null;
  readonly channel: string;

  private constructor(requestId: string) {
    this.channel = askChannel(requestId);
    listeners.set(this.channel, (reply) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(reply);
      } else {
        this.queue.push(reply);
      }
    });
  }

  /** Subscribed before any task is sent, so no reply can arrive unheard. */
  static async open(requestId: string): Promise<Replies> {
    const replies = new Replies(requestId);
    await clients().subscriber.subscribe(replies.channel);
    return replies;
  }

  next(timeoutMs: number): Promise<AskReply | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        resolve(null);
      }, timeoutMs);
      this.waiting = (reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
    });
  }

  async close(): Promise<void> {
    listeners.delete(this.channel);
    await clients().subscriber.unsubscribe(this.channel).catch(() => undefined);
  }
}

/**
 * A sliding minute, not a fixed one: with fixed windows, questions asked
 * either side of the turn of a minute counted in different windows, so twice
 * the limit could go through in a few seconds. Each question is a timestamp in
 * a sorted set; only the last 60 seconds of them count.
 */
async function overLimit(participantId: string): Promise<boolean> {
  const key = `rmcollab:ask-rate:${participantId}`;
  const now = Date.now();
  const results = (await clients()
    .redis.multi()
    .zremrangebyscore(key, 0, now - 60_000)
    .zadd(key, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
    .zcard(key)
    .expire(key, 70)
    .exec()) as [Error | null, number][];
  return (results[2]?.[1] ?? 0) > ASKS_PER_MINUTE;
}

/** The room's notes as retrieval candidates; a long section is split like a document. */
async function notesCandidates(roomId: string): Promise<Omit<NotesCandidate, "vector">[]> {
  const out: Omit<NotesCandidate, "vector">[] = [];
  // Every document in the room, its notes first: a candidate's key carries
  // which one ("<docId>|<section>#<piece>"), so a citation can open it.
  for (const document of await listDocuments(roomId)) {
    const doc = await docHub.document(docKey(roomId, document.id));
    for (const section of notesSections(doc.getXmlFragment(NOTES_FIELD))) {
      // Outside the room's own notes, the document's name says where it is.
      const title = document.isMain
        ? section.title
        : section.key === "top"
          ? document.title
          : `${document.title} · ${section.title}`;
      splitPassages("notes", section.text).forEach((piece, i) => {
        out.push({ key: `${document.id}|${section.key}#${i}`, title, text: piece.body });
      });
    }
  }
  return out.slice(0, MAX_NOTES_PIECES);
}

/** A notes candidate's key, split: its document, and its section there. */
export function splitNotesKey(key: string | null): { docId: string | null; section: string | null } {
  if (!key) return { docId: null, section: null };
  const at = key.indexOf("|");
  const docId = at === -1 ? MAIN_DOC_ID : key.slice(0, at);
  const section = (at === -1 ? key : key.slice(at + 1)).split("#")[0] || null;
  return { docId, section };
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

/** How a passage is introduced to the model, so it can say where things came from. */
export function describeSource(r: Retrieved): string {
  switch (r.kind) {
    case "transcript":
      return `${r.mediaType === "video" ? "Video" : "Recording"} ${r.title}${r.startS === null ? "" : `, at ${clock(r.startS)}`}`;
    case "summary":
      return `Summary of ${r.title}`;
    case "notes":
      return `Room notes: ${r.title}`;
    default:
      return r.mediaType === "image" ? `Notes from the image ${r.title}` : `Document: ${r.title}`;
  }
}

/** The upload an upload's notes section ("u:<mediaItemId>#<piece>") belongs to. */
const sectionUpload = (notesKey: string | null): string | null => {
  const { section } = splitNotesKey(notesKey);
  return section?.startsWith("u:") ? section.slice(2) || null : null;
};

/**
 * An upload's notes section repeats that upload's own documents. Wherever the
 * upload itself ranks, its section is a duplicate - and a worse one, with no
 * timestamp to seek to - taking a place another source could have had. It is
 * kept only when the upload's documents did not rank at all (a person may have
 * rewritten the section, or the upload's passages are still being embedded),
 * and then it still points at its upload.
 */
export function withoutDuplicates(ranked: Retrieved[], limit: number): Retrieved[] {
  const uploads = new Set(ranked.filter((r) => r.kind !== "notes" && r.mediaItemId).map((r) => r.mediaItemId!));
  return ranked
    .filter((r) => !(r.kind === "notes" && uploads.has(sectionUpload(r.notesKey) ?? "")))
    .map((r) => (r.kind === "notes" && sectionUpload(r.notesKey) ? { ...r, mediaItemId: sectionUpload(r.notesKey) } : r))
    .slice(0, limit);
}

/**
 * A passage as a person reads it in a source card: summaries and image notes
 * are stored as Markdown, and "## Message queues - decouple..." is noise.
 */
export function plainExcerpt(body: string): string {
  return body
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function toSource(r: Retrieved, n: number): AskSource {
  const plain = plainExcerpt(r.body);
  const excerpt = plain.length > EXCERPT_CHARS ? `${plain.slice(0, EXCERPT_CHARS).replace(/\s+\S*$/, "")}…` : plain;
  return {
    n,
    kind: r.kind,
    title: r.title,
    excerpt,
    mediaItemId: r.mediaItemId,
    artifactId: r.artifactId,
    atSeconds: r.startS,
    notesKey: splitNotesKey(r.notesKey).section,
    docId: r.kind === "notes" ? splitNotesKey(r.notesKey).docId : null,
  };
}

/**
 * Square brackets for citations, whatever the model wrote: gpt-oss models often
 * cite as 【1】 or ［1］. Each bracket is one character, so this is safe on a
 * streamed piece even when a citation is split across pieces.
 */
export const plainBrackets = (text: string): string => text.replace(/[【［]/g, "[").replace(/[】］]/g, "]");

/** The [n] citations in an answer that point at a real source, in order of first use. */
export function citations(answer: string, sources: number): number[] {
  const seen: number[] = [];
  for (const match of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(match[1]);
    if (n >= 1 && n <= sources && !seen.includes(n)) seen.push(n);
  }
  return seen;
}

export interface AskRequest {
  roomId: string;
  participantId: string;
  requestId: string;
  question: string;
  /** Earlier turns, for a follow-up. */
  history?: AskHistoryTurn[];
  send: (event: ServerEvent) => void;
}

export async function answerQuestion({ roomId, participantId, requestId, question: asked, history = [], send }: AskRequest): Promise<void> {
  const done = (extra: Partial<Extract<ServerEvent, { type: "ask_done" }>>) =>
    send({ type: "ask_done", requestId, cited: [], ...extra });
  const fallback = (reason: AskFallback) => done({ fallback: reason });

  if (await overLimit(participantId)) return fallback("rate_limited");

  const started = Date.now();
  // The reply channel is named by the server, not by the client's requestId:
  // two requests with the same id (a retry, or someone else's id) must not
  // share a channel and hear each other's answers. The client's id is only
  // used to label what is sent back to it.
  const taskId = `${requestId.slice(0, 32)}.${nanoid(12)}`;
  const replies = await Replies.open(taskId);
  try {
    const notes = await notesCandidates(roomId);
    const prepare: AskPrepareTask = {
      request_id: taskId,
      question: asked,
      notes: notes.map((n) => ({ id: n.key, text: `${n.title}\n${n.text}` })),
      history,
    };
    await enqueueTask(TASK_ASK_PREPARE, QUEUE_ASK, prepare as unknown as Record<string, unknown>);

    const vectors = await replies.next(PREPARE_TIMEOUT_MS);
    if (!vectors) return fallback("timeout");
    if (vectors.type !== "vectors" || !vectors.question) return fallback("failed");
    // A follow-up is searched for, and answered, as the question it stands for.
    const question = vectors.standalone?.trim() || asked;
    const noteVectors = new Map((vectors.notes ?? []).map((v) => [v.id, v.vector]));
    const candidates: NotesCandidate[] = notes.map((n) => {
      const encoded = noteVectors.get(n.key);
      return { ...n, vector: encoded ? decodeVector(encoded) : null };
    });

    const ranked = withoutDuplicates(
      await retrieve(roomId, question, decodeVector(vectors.question), candidates, PASSAGES * 2),
      PASSAGES,
    );
    const retrievedMs = Date.now() - started;
    if (ranked.length === 0) return done({ noEvidence: true });

    const sources = ranked.map((r, i) => toSource(r, i + 1));
    send({ type: "ask_sources", requestId, sources, ...(question !== asked ? { standalone: question } : {}) });

    const answer: AskAnswerTask = {
      request_id: taskId,
      question,
      passages: ranked.map((r, i) => ({ n: i + 1, source: describeSource(r), text: r.body })),
    };
    await enqueueTask(TASK_ASK_ANSWER, QUEUE_ASK, answer as unknown as Record<string, unknown>);

    let text = "";
    let firstWordsMs: number | null = null;
    const deadline = Date.now() + ANSWER_TIMEOUT_MS;
    for (;;) {
      const wait = text ? Math.max(0, deadline - Date.now()) : FIRST_WORDS_TIMEOUT_MS;
      const reply = await replies.next(wait);
      if (!reply) return done({ fallback: "timeout", cited: citations(text, sources.length) });
      if (reply.type === "delta" && reply.text) {
        firstWordsMs ??= Date.now() - started;
        const piece = plainBrackets(reply.text);
        text += piece;
        send({ type: "ask_delta", requestId, text: piece });
      } else if (reply.type === "done") {
        console.log(
          `[ask] ${requestId}: ${sources.length} passages in ${retrievedMs}ms, first words ${firstWordsMs ?? "-"}ms, ` +
            `done ${Date.now() - started}ms (${reply.model ?? "?"})`,
        );
        return done({ cited: citations(text, sources.length), ...(reply.model ? { model: reply.model } : {}) });
      } else if (reply.type === "error") {
        const code = reply.code === "no_model" || reply.code === "quota" ? reply.code : "failed";
        console.warn(`[ask] ${requestId}: ${code} - ${reply.message ?? ""}`);
        return done({ fallback: code, cited: citations(text, sources.length) });
      }
    }
  } finally {
    await replies.close();
  }
}

export async function closeAsk(): Promise<void> {
  if (!connections) return;
  await Promise.allSettled([connections.redis.quit(), connections.subscriber.quit()]);
  connections = null;
}
