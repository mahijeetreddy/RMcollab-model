import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
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

export interface DocHubOptions {
  store: DocStore;
  publish(roomId: string, data: string, from: string): Promise<unknown>;
  /** Batch window: keystrokes within it become one stored row. */
  flushMs?: number;
  compactAfter?: number;
  log?: (message: string, err?: unknown) => void;
}

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
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

  constructor(private readonly options: DocHubOptions) {
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
    await this.flush(roomId, room);
    this.destroy(room);
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
      (parts) => {
        // Applied as one merged update: a single transaction, one render.
        if (parts.length > 0) Y.applyUpdate(room.doc, Y.mergeUpdates(parts), FROM_STORAGE);
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

  private destroy(room: RoomDoc): void {
    if (room.flushTimer) clearTimeout(room.flushTimer);
    if (room.catchUpTimer) clearTimeout(room.catchUpTimer);
    room.awareness.destroy();
    room.doc.destroy();
  }
}
