import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import { NOTES_FIELD } from "@rmcollab/shared/notes";
import * as Y from "yjs";

/**
 * Room notes: one Yjs CRDT document per room, edited by everyone in it.
 *
 * Each gateway replica keeps an in-memory copy of a room's document while any of
 * its sockets are editing it. Edits from a local socket are applied, saved, and
 * published through Redis; every replica - including the publisher, following
 * the same publish-then-deliver-on-receive rule as the rest of the room - applies
 * what arrives and forwards it to its own editors. Because a CRDT merge is
 * commutative and idempotent, none of that needs ordering or de-duplication: an
 * update applied twice, or in a different order on another replica, converges to
 * the same document.
 *
 * Messages are y-protocols framing (the y-websocket wire format) carried as
 * base64 inside the existing JSON socket, so the room's access check guards the
 * document like everything else a room holds.
 */

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** Transaction origins that must not be re-saved or re-published. */
const FROM_REMOTE = Symbol("remote");
const FROM_STORAGE = Symbol("storage");
const FROM_CLOSE = Symbol("close");
/**
 * Content found by the catch-up reload may be missing on this replica's editors
 * (it arrived before they subscribed), so unlike the initial load it is
 * forwarded to them - but, like it, never re-saved or re-published.
 */
const FROM_STORAGE_CATCH_UP = Symbol("storage-catch-up");
/** Origin for edits the gateway itself makes (the AI writer, later). */
export const FROM_SERVER = "server";

export interface DocPeer {
  /** Unique per connection; used to avoid echoing an edit to its author. */
  id: string;
  send(data: string): void;
}

export interface DocStore {
  load(roomId: string): Promise<Uint8Array[]>;
  /** Returns how many batches now await compaction. */
  append(roomId: string, update: Uint8Array): Promise<number>;
  compact(roomId: string): Promise<unknown>;
}

/** Where restore points go. Optional: without it the hub keeps no history. */
export interface DocHistory {
  save(roomId: string, state: Uint8Array, reason: string, words: number): Promise<unknown>;
  latestAt(roomId: string): Promise<number | null>;
}

export interface DocHubOptions {
  store: DocStore;
  history?: DocHistory;
  /** How often a room being edited gets a restore point. */
  versionEveryMs?: number;
  publish(roomId: string, data: string, from: string): Promise<unknown>;
  /** Batch window: keystrokes within it become one stored row. */
  flushMs?: number;
  compactAfter?: number;
  log?: (message: string, err?: unknown) => void;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

/** A deletion this large, against a recent copy, gets a restore point first. */
const LARGE_DELETION_CHARS = 400;
const LARGE_DELETION_SHARE = 0.4;
/** How stale the kept copy may get. A copy is refreshed whenever the notes grow. */
const BASELINE_MS = 30_000;
/**
 * Attempts at the final save when a copy is released. Its last editor has gone,
 * so nobody would resend what a failed save loses; a few tries ride out a
 * database blip. Not unbounded: a room deleted meanwhile fails for good.
 */
const RELEASE_SAVE_ATTEMPTS = 3;

/** The notes' size in characters of markup: enough to notice most of it vanishing. */
function notesSize(doc: Y.Doc): number {
  return doc.getXmlFragment(NOTES_FIELD).toString().length;
}

/** Words in a saved state, for the version list. */
export function wordsIn(state: Uint8Array): number {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  const text = doc.getXmlFragment(NOTES_FIELD).toString().replace(/<[^>]+>/g, " ");
  doc.destroy();
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
const fromBase64 = (data: string) => new Uint8Array(Buffer.from(data, "base64"));

function syncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

function awarenessMessage(awareness: awarenessProtocol.Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

class RoomDoc {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  readonly peers = new Map<string, DocPeer>();
  /** Awareness client ids each connection owns, removed when it leaves. */
  readonly owned = new Map<string, Set<number>>();
  pending: Uint8Array[] = [];
  flushTimer: NodeJS.Timeout | null = null;
  /** A recent copy of the whole document and its size, to restore if much of it is deleted. */
  baseline: { state: Uint8Array; size: number; at: number } | null = null;
  lastVersionAt = 0;
  catchUpTimer: NodeJS.Timeout | null = null;
  ready: Promise<void> = Promise.resolve();

  constructor() {
    // The gateway is not a participant; it should not appear as a cursor.
    this.awareness.setLocalState(null);
  }
}

export class RoomDocHub {
  private readonly rooms = new Map<string, RoomDoc>();
  private readonly flushMs: number;
  private readonly compactAfter: number;
  private readonly log: (message: string, err?: unknown) => void;
  private readonly versionEveryMs: number;

  constructor(private readonly options: DocHubOptions) {
    this.versionEveryMs = options.versionEveryMs ?? 60 * 60 * 1000;
    this.flushMs = options.flushMs ?? 400;
    this.compactAfter = options.compactAfter ?? 200;
    this.log = options.log ?? ((message, err) => console.warn(`[docs] ${message}`, err ?? ""));
  }

  /** A frame from a local socket that is in `roomId`. */
  async receive(roomId: string, peer: DocPeer, data: string): Promise<void> {
    const room = this.open(roomId);
    await room.ready;

    const decoder = decoding.createDecoder(fromBase64(data));
    const kind = decoding.readVarUint(decoder);

    if (kind === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      // Updates are applied with the peer's id as origin, which is how the
      // update listener knows to save and publish them.
      const step = syncProtocol.readSyncMessage(decoder, reply, room.doc, peer.id);
      if (encoding.length(reply) > 1) peer.send(toBase64(encoding.toUint8Array(reply)));

      if (step === syncProtocol.messageYjsSyncStep1) {
        // A (re)joining editor: ask for anything it has that we do not - which
        // is how edits survive even a crash between typing and saving - and
        // show it everyone already here.
        room.peers.set(peer.id, peer);
        const ask = encoding.createEncoder();
        encoding.writeVarUint(ask, MESSAGE_SYNC);
        syncProtocol.writeSyncStep1(ask, room.doc);
        peer.send(toBase64(encoding.toUint8Array(ask)));
        const present = [...room.awareness.getStates().keys()];
        if (present.length > 0) peer.send(toBase64(awarenessMessage(room.awareness, present)));
      }
      return;
    }

    if (kind === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), peer.id);
      return;
    }
    throw new Error(`unknown doc message type ${kind}`);
  }

  /** A frame published by any replica (this one included) for `roomId`. */
  relay(roomId: string, data: string, from: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return; // nobody here is editing; storage has it
    const decoder = decoding.createDecoder(fromBase64(data));
    const kind = decoding.readVarUint(decoder);
    if (kind === MESSAGE_SYNC) {
      // Idempotent on the publishing replica, which already applied it.
      syncProtocol.readSyncMessage(decoder, encoding.createEncoder(), room.doc, FROM_REMOTE);
    } else if (kind === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), FROM_REMOTE);
    }
    for (const [id, peer] of room.peers) if (id !== from) peer.send(data);
  }

  /** A socket left the room or closed: drop it and its cursors. */
  leave(roomId: string, peerId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.delete(peerId);
    const owned = room.owned.get(peerId);
    room.owned.delete(peerId);
    if (owned && owned.size > 0) {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], FROM_CLOSE);
    }
  }

  /**
   * This replica stopped receiving the room's Redis traffic (its last socket
   * left), so its copy would silently go stale: save it and let it go. A copy
   * kept past this point would answer the next joiner with a document missing
   * everything edited elsewhere in the meantime. The next editor reloads it.
   */
  async drop(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    await room.ready.catch(() => undefined);
    // flush puts a failed batch back in `pending`, so what is left is unsaved.
    for (let attempt = 1; attempt <= RELEASE_SAVE_ATTEMPTS; attempt += 1) {
      await this.flush(roomId, room);
      if (room.pending.length === 0) break;
      if (attempt < RELEASE_SAVE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    if (room.pending.length > 0) this.log(`gave up saving ${roomId} as it was released`);
    this.destroy(room);
  }

  /**
   * A document that was deleted: released without saving, since what it holds
   * belongs to nothing any more - a save here would leave rows for a document
   * that no longer exists. Its editors are told by the room's own event.
   */
  discard(key: string): void {
    const room = this.rooms.get(key);
    if (!room) return;
    this.rooms.delete(key);
    this.destroy(room);
  }

  /** The keys of a room's documents open here: its main one and any `<roomId>:<docId>`. */
  keysOf(roomId: string): string[] {
    return [...this.rooms.keys()].filter((key) => key === roomId || key.startsWith(`${roomId}:`));
  }

  /** A socket left a room: out of every document of it. */
  leaveAll(roomId: string, peerId: string): void {
    for (const key of this.keysOf(roomId)) this.leave(key, peerId);
  }

  /** This replica stopped hearing a room: save and release every document of it. */
  async dropAll(roomId: string): Promise<void> {
    await Promise.all(this.keysOf(roomId).map((key) => this.drop(key)));
  }

  /** The current document, loading it if needed. */
  async document(roomId: string): Promise<Y.Doc> {
    const room = this.open(roomId);
    await room.ready;
    return room.doc;
  }

  /**
   * A change made by the gateway itself (the notes writer), saved before this
   * returns.
   *
   * Saved synchronously rather than batched because of what follows: the
   * placeholder for an upload is written here, then the job is queued, and its
   * completion may be handled by a different replica - which, if it has no
   * editors in the room, loads the document from storage. Were the placeholder
   * still sitting in a batch, that replica would not find it and the upload
   * would get two sections.
   *
   * A replica with no editors in the room is not receiving its Redis traffic,
   * so a copy loaded just for this edit is dropped straight after it.
   */
  async edit(roomId: string, change: (doc: Y.Doc) => void): Promise<void> {
    const alreadyOpen = this.rooms.has(roomId);
    const room = this.open(roomId);
    await room.ready;
    room.doc.transact(() => change(room.doc), FROM_SERVER);
    await this.flush(roomId, room);
    // Kept while a failed save is waiting to retry: destroying the copy would
    // throw that batch away with it.
    if (!alreadyOpen && room.peers.size === 0 && room.pending.length === 0 && this.rooms.get(roomId) === room) {
      this.rooms.delete(roomId);
      this.destroy(room);
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.entries()].map(([roomId, room]) => this.flush(roomId, room)));
  }

  isLoaded(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  private open(roomId: string): RoomDoc {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;

    const room = new RoomDoc();
    this.rooms.set(roomId, room);

    room.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === FROM_REMOTE || origin === FROM_STORAGE) return;
      if (origin === FROM_STORAGE_CATCH_UP) {
        const data = toBase64(syncUpdateMessage(update));
        for (const peer of room.peers.values()) peer.send(data);
        return;
      }
      room.pending.push(update);
      this.scheduleFlush(roomId, room);
      const from = typeof origin === "string" ? origin : FROM_SERVER;
      this.options
        .publish(roomId, toBase64(syncUpdateMessage(update)), from)
        .catch((err) => this.log(`publish failed for ${roomId}`, err));
    });

    room.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === FROM_REMOTE) return;
        if (typeof origin === "string") {
          const mine = room.owned.get(origin) ?? new Set<number>();
          for (const id of [...added, ...updated]) mine.add(id);
          for (const id of removed) mine.delete(id);
          room.owned.set(origin, mine);
        }
        const changed = [...added, ...updated, ...removed];
        const from = typeof origin === "string" ? origin : FROM_SERVER;
        this.options
          .publish(roomId, toBase64(awarenessMessage(room.awareness, changed)), from)
          .catch((err) => this.log(`awareness publish failed for ${roomId}`, err));
      },
    );

    room.ready = this.options.store.load(roomId).then(
      async (parts) => {
        // Applied as one merged update: a single transaction, one render.
        if (parts.length > 0) Y.applyUpdate(room.doc, Y.mergeUpdates(parts), FROM_STORAGE);
        room.baseline = { state: Y.encodeStateAsUpdate(room.doc), size: notesSize(room.doc), at: Date.now() };
        // Known before the first save, or every edit to a room not open here
        // would look an hour overdue for a restore point.
        try {
          room.lastVersionAt = (await this.options.history?.latestAt(roomId)) ?? 0;
        } catch {
          room.lastVersionAt = Date.now();
        }
        // A batch another replica published just before this one subscribed,
        // and had not saved yet when the load ran, would otherwise be missed:
        // read storage once more after a flush window. Idempotent, so cheap.
        room.catchUpTimer = setTimeout(() => {
          room.catchUpTimer = null;
          if (this.rooms.get(roomId) !== room) return;
          this.options.store.load(roomId).then(
            (later) => {
              if (later.length > 0 && this.rooms.get(roomId) === room) {
                Y.applyUpdate(room.doc, Y.mergeUpdates(later), FROM_STORAGE_CATCH_UP);
              }
            },
            (err) => this.log(`catch-up load failed for ${roomId}`, err),
          );
        }, this.flushMs * 3);
        room.catchUpTimer.unref?.();
      },
      (err) => {
        this.rooms.delete(roomId);
        this.destroy(room);
        throw err;
      },
    );
    return room;
  }

  private scheduleFlush(roomId: string, room: RoomDoc): void {
    if (room.flushTimer) return;
    room.flushTimer = setTimeout(() => {
      room.flushTimer = null;
      void this.flush(roomId, room);
    }, this.flushMs);
    room.flushTimer.unref?.();
  }

  private async flush(roomId: string, room: RoomDoc): Promise<void> {
    if (room.flushTimer) {
      clearTimeout(room.flushTimer);
      room.flushTimer = null;
    }
    if (room.pending.length === 0) return;
    const batch = room.pending;
    room.pending = [];
    this.keepHistory(roomId, room);
    try {
      const waiting = await this.options.store.append(roomId, Y.mergeUpdates(batch));
      if (waiting >= this.compactAfter) {
        void this.options.store.compact(roomId).catch((err) => this.log(`compaction failed for ${roomId}`, err));
      }
    } catch (err) {
      // Put the batch back for the next flush. Even if this replica dies first,
      // every editor holds the full document and resends it on reconnect.
      room.pending = [...batch, ...room.pending];
      this.log(`saving ${roomId} failed; will retry`, err);
      this.scheduleFlush(roomId, room);
    }
  }

  /**
   * Restore points, checked once per saved batch rather than per keystroke:
   *   - before a large deletion: the notes shrank by 40% and 400 characters
   *     against a copy at most BASELINE_MS old, so that copy is kept
   *   - hourly, while the room is being edited
   * Saving is fire-and-forget; history must never slow down or fail an edit.
   */
  private keepHistory(roomId: string, room: RoomDoc): void {
    const history = this.options.history;
    if (!history) return;
    const now = Date.now();
    const size = notesSize(room.doc);
    const base = room.baseline;
    const save = (state: Uint8Array, reason: string) =>
      history
        .save(roomId, state, reason, wordsIn(state))
        .catch((err: unknown) => this.log(`saving a version of ${roomId} failed`, err));

    if (base && base.size - size >= LARGE_DELETION_CHARS && size <= base.size * (1 - LARGE_DELETION_SHARE)) {
      void save(base.state, "Before a large deletion");
      room.lastVersionAt = now;
      // The next deletion is measured from here, not from the copy just kept.
      room.baseline = { state: Y.encodeStateAsUpdate(room.doc), size, at: now };
      return;
    } else if (now - room.lastVersionAt >= this.versionEveryMs) {
      void save(Y.encodeStateAsUpdate(room.doc), "Hourly");
      room.lastVersionAt = now;
    }
    if (!base || now - base.at >= BASELINE_MS || size >= base.size) {
      room.baseline = { state: Y.encodeStateAsUpdate(room.doc), size, at: now };
    }
  }

  private destroy(room: RoomDoc): void {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    if (room.catchUpTimer) clearTimeout(room.catchUpTimer);
    room.awareness.destroy();
    room.doc.destroy();
  }
}
