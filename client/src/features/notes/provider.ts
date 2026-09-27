import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * Connects a room's Y.Doc to the gateway over the existing realtime socket.
 *
 * The wire format is y-protocols' (as y-websocket uses), base64 inside a JSON
 * `doc` event, so the room's access check guards the notes too. The gateway
 * relays across replicas and persists; this side only speaks the protocol.
 *
 * Offline edits need no special handling: they sit in the local Y.Doc, and the
 * sync handshake on reconnect sends the server exactly what it is missing.
 */

export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

export type SyncStatus = "connecting" | "synced" | "offline";

export interface CollaboratorUser {
  name: string;
  color: string;
  /** Participant id, so the same person on two tabs is shown once. */
  id: string;
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

const fromBase64 = (data: string): Uint8Array => {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

// Throttle for answering a newcomer: many can arrive at once on a busy room.
const REANNOUNCE_MS = 500;

export class RoomDocProvider {
  readonly awareness: awarenessProtocol.Awareness;
  status: SyncStatus = "connecting";
  private readonly statusListeners = new Set<(status: SyncStatus) => void>();
  private reannounceTimer: number | null = null;
  private destroyed = false;

  constructor(
    readonly doc: Y.Doc,
    private readonly send: (data: string) => boolean,
    user: CollaboratorUser,
  ) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalStateField("user", user);
    doc.on("update", this.onDocUpdate);
    this.awareness.on("update", this.onAwarenessUpdate);
  }

  /** Call on every (re)connection to the room: the sync handshake starts here. */
  connect(): void {
    if (this.destroyed) return;
    this.setStatus("connecting");
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.transmit(encoding.toUint8Array(encoder));
    this.announce();
  }

  disconnected(): void {
    this.setStatus("offline");
  }

  receive(data: string): void {
    if (this.destroyed) return;
    const decoder = decoding.createDecoder(fromBase64(data));
    const kind = decoding.readVarUint(decoder);
    if (kind === MESSAGE_SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, MESSAGE_SYNC);
      // Origin `this`, so onDocUpdate does not send the server's own edits back.
      const step = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (encoding.length(reply) > 1) this.transmit(encoding.toUint8Array(reply));
      if (step === syncProtocol.messageYjsSyncStep2) this.setStatus("synced");
    } else if (kind === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  onStatus(listener: (status: SyncStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  destroy(): void {
    if (this.destroyed) return;
    // Tell the room this cursor is gone now, rather than after the 30s expiry.
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "local");
    this.destroyed = true;
    if (this.reannounceTimer !== null) window.clearTimeout(this.reannounceTimer);
    this.doc.off("update", this.onDocUpdate);
    this.awareness.off("update", this.onAwarenessUpdate);
    this.awareness.destroy();
    this.statusListeners.clear();
  }

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.transmit(encoding.toUint8Array(encoder));
  };

  private readonly onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) {
      // Someone new appeared. Presence is not stored anywhere, so a newcomer
      // who joined through another gateway replica cannot see existing cursors
      // until their owners re-announce - which would otherwise take up to 15s.
      if (added.some((id) => id !== this.doc.clientID)) this.scheduleReannounce();
      return;
    }
    const changed = [...added, ...updated, ...removed];
    if (changed.length === 0) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
    this.transmit(encoding.toUint8Array(encoder));
  };

  private announce(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]),
    );
    this.transmit(encoding.toUint8Array(encoder));
  }

  private scheduleReannounce(): void {
    if (this.reannounceTimer !== null) return;
    this.reannounceTimer = window.setTimeout(() => {
      this.reannounceTimer = null;
      if (!this.destroyed) this.announce();
    }, REANNOUNCE_MS);
  }

  private transmit(bytes: Uint8Array): void {
    if (!this.send(toBase64(bytes)) && this.status !== "offline") this.setStatus("offline");
  }

  private setStatus(status: SyncStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const listener of this.statusListeners) listener(status);
  }
}
