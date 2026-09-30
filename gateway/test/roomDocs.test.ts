import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import { MESSAGE_AWARENESS, MESSAGE_SYNC, RoomDocHub, type DocStore } from "../src/docs/roomDocs.js";

const ROOM = "room-1";
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const unb64 = (data: string) => new Uint8Array(Buffer.from(data, "base64"));

/** Postgres stand-in: an append log plus a snapshot, like the real tables. */
class MemoryStore implements DocStore {
  rows: Uint8Array[] = [];
  snapshot: Uint8Array | null = null;
  appends = 0;
  failNext = false;
  async load() {
    return [...(this.snapshot ? [this.snapshot] : []), ...this.rows];
  }
  async append(_room: string, update: Uint8Array) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("db down");
    }
    this.appends += 1;
    this.rows.push(update);
    return this.rows.length;
  }
  async compact() {
    this.snapshot = Y.mergeUpdates([...(this.snapshot ? [this.snapshot] : []), ...this.rows]);
    this.rows = [];
  }
  text() {
    const doc = new Y.Doc();
    const parts = [...(this.snapshot ? [this.snapshot] : []), ...this.rows];
    if (parts.length) Y.applyUpdate(doc, Y.mergeUpdates(parts));
    return doc.getText("t").toString();
  }
}

/**
 * Redis stand-in: every publish reaches every replica, the publisher included -
 * the same rule the real pub/sub follows.
 */
class Bus {
  hubs: RoomDocHub[] = [];
  published = 0;
  publish = async (roomId: string, data: string, from: string) => {
    this.published += 1;
    for (const hub of this.hubs) hub.relay(roomId, data, from);
  };
}

/** A browser: its own Y.Doc, speaking y-protocols to one replica. */
class Client {
  doc = new Y.Doc();
  awareness = new awarenessProtocol.Awareness(this.doc);
  received: string[] = [];
  readonly peer: { id: string; send: (data: string) => void };
  constructor(
    readonly id: string,
    private readonly hub: RoomDocHub,
  ) {
    // Built here, not as a field initializer: fields initialise before
    // parameter properties are assigned, which left every peer's id undefined.
    this.peer = { id, send: (data) => this.handle(data) };
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "server") return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MESSAGE_SYNC);
      syncProtocol.writeUpdate(e, update);
      void this.hub.receive(ROOM, this.peer, b64(encoding.toUint8Array(e)));
    });
  }
  private handle(data: string) {
    {
      this.received.push(data);
      const decoder = decoding.createDecoder(unb64(data));
      const kind = decoding.readVarUint(decoder);
      if (kind === MESSAGE_SYNC) {
        const reply = encoding.createEncoder();
        encoding.writeVarUint(reply, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, reply, this.doc, "server");
        if (encoding.length(reply) > 1) void this.hub.receive(ROOM, this.peer, b64(encoding.toUint8Array(reply)));
      } else if (kind === MESSAGE_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), "server");
      }
    }
  }
  async connect() {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    await this.hub.receive(ROOM, this.peer, b64(encoding.toUint8Array(e)));
    await settle();
  }
  async announce(name: string) {
    this.awareness.setLocalStateField("user", { name });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    await this.hub.receive(ROOM, this.peer, b64(encoding.toUint8Array(e)));
  }
  type(at: number, text: string) {
    this.doc.getText("t").insert(at, text);
  }
  get text() {
    return this.doc.getText("t").toString();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

function cluster(replicas = 2, store = new MemoryStore()) {
  const bus = new Bus();
  const hubs = Array.from(
    { length: replicas },
    () => new RoomDocHub({ store, publish: bus.publish, flushMs: 20, compactAfter: 1000, log: () => undefined }),
  );
  bus.hubs = hubs;
  return { store, bus, hubs };
}

afterEach(() => vi.useRealTimers());

describe("RoomDocHub", () => {
  it("converges two editors on different replicas", async () => {
    const { hubs } = cluster(2);
    const alice = new Client("alice", hubs[0]!);
    const bob = new Client("bob", hubs[1]!);
    await alice.connect();
    await bob.connect();

    alice.type(0, "Queues ");
    await settle();
    bob.type(0, "Redis ");
    await settle();
    expect(alice.text).toBe(bob.text);
    expect(alice.text).toContain("Queues");
    expect(alice.text).toContain("Redis");
  });

  it("merges concurrent edits to the same spot without losing either", async () => {
    // The case a last-write-wins text field gets wrong.
    const { hubs } = cluster(2);
    const alice = new Client("alice", hubs[0]!);
    const bob = new Client("bob", hubs[1]!);
    await alice.connect();
    await bob.connect();
    alice.type(0, "shared line");
    await settle();

    // Both edit before either sees the other's change.
    alice.doc.getText("t").insert(0, "[A]");
    bob.doc.getText("t").insert(0, "[B]");
    await settle();
    expect(alice.text).toBe(bob.text);
    expect(alice.text).toMatch(/\[A\]/);
    expect(alice.text).toMatch(/\[B\]/);
    expect(alice.text).toMatch(/shared line$/);
  });

  it("gives a late joiner the whole document", async () => {
    const { hubs, store } = cluster(2);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    alice.type(0, "written before bob arrived");
    // Waited for, not guessed at with a fixed delay, which a busy machine outlasts.
    await vi.waitFor(() => expect(store.text()).toBe("written before bob arrived"), { timeout: 2000, interval: 10 });

    const bob = new Client("bob", hubs[1]!);
    await bob.connect();
    expect(bob.text).toBe("written before bob arrived");
  });

  it("catches up on an edit still being saved when a replica loaded the room", async () => {
    // Bob's replica loads from storage while Alice's replica is inside its
    // batch window, so the edit is neither stored yet nor relayed to a replica
    // that was not listening. The catch-up reload finds it and forwards it.
    const { hubs, bus } = cluster(2);
    bus.hubs = [hubs[0]!]; // replica 2 is not subscribed to the room yet
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    alice.type(0, "in flight");
    await settle(); // published, but inside the 20ms batch window: not stored

    bus.hubs = hubs; // replica 2 subscribes, and Bob loads from storage
    const bob = new Client("bob", hubs[1]!);
    await bob.connect();
    expect(bob.text).toBe("");
    await vi.waitFor(() => expect(bob.text).toBe("in flight"), { timeout: 2000, interval: 10 });
  });

  it("batches keystrokes into far fewer stored rows", async () => {
    const { hubs, store } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    for (const ch of "a sentence typed one key at a time") alice.type(alice.text.length, ch);
    await vi.waitFor(() => expect(store.text()).toBe("a sentence typed one key at a time"), { timeout: 2000, interval: 10 });
    expect(store.appends).toBeLessThanOrEqual(2);
  });

  it("persists each edit once, not once per replica", async () => {
    const { hubs, store } = cluster(3);
    const clients = hubs.map((hub, i) => new Client(`c${i}`, hub));
    for (const c of clients) await c.connect();
    clients[0]!.type(0, "once");
    await vi.waitFor(() => expect(store.text()).toBe("once"), { timeout: 2000, interval: 10 });
    // Then a little longer: a duplicate save from another replica would land by now.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(store.appends).toBe(1);
  });

  it("never echoes an edit back to the socket that made it", async () => {
    const { hubs } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    const before = alice.received.length;
    alice.type(0, "mine");
    await settle();
    expect(alice.received.length).toBe(before);
  });

  it("recovers an edit the server failed to save from the editor's own copy", async () => {
    // Every editor holds the full document, so a sync after a failure (or a
    // replica restart) restores what storage lost.
    const store = new MemoryStore();
    const first = cluster(1, store);
    const alice = new Client("alice", first.hubs[0]!);
    await alice.connect();
    store.failNext = true;
    alice.type(0, "unsaved at first");
    await vi.waitFor(() => expect(store.text()).toBe("unsaved at first"), { timeout: 2000, interval: 10 }); // retried after the failure

    // A replica that never saw it: alice resyncs and the edit comes back.
    const second = cluster(1, new MemoryStore());
    const reconnect = new Client("alice", second.hubs[0]!);
    Y.applyUpdate(reconnect.doc, Y.encodeStateAsUpdate(alice.doc));
    await reconnect.connect();
    await vi.waitFor(() => expect(second.store.text()).toBe("unsaved at first"), { timeout: 2000, interval: 10 });
  });

  it("drops a document it no longer receives updates for, after saving it", async () => {
    const { hubs, store } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    alice.type(0, "keep me");
    hubs[0]!.leave(ROOM, "alice");
    await hubs[0]!.drop(ROOM);
    expect(hubs[0]!.isLoaded(ROOM)).toBe(false);
    expect(store.text()).toBe("keep me");
  });

  it("retries the final save when its last editor leaves during a database blip", async () => {
    const { hubs, store } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    alice.type(0, "last words");
    store.failNext = true;
    hubs[0]!.leave(ROOM, "alice");
    await hubs[0]!.drop(ROOM);
    expect(store.text()).toBe("last words");
  });

  it("discards a deleted document without saving what it held", async () => {
    const { hubs, store } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    alice.type(0, "in a document being deleted");
    hubs[0]!.discard(ROOM);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(hubs[0]!.isLoaded(ROOM)).toBe(false);
    expect(store.appends).toBe(0);
  });

  it("shows a collaborator's presence across replicas and removes it when they leave", async () => {
    // Presence is not stored: one announced before a replica was listening
    // reaches it when its owner re-announces, which the client does as soon
    // as a newcomer appears (client/src/features/notes/provider.ts).
    const { hubs } = cluster(2);
    const alice = new Client("alice", hubs[0]!);
    const bob = new Client("bob", hubs[1]!);
    await alice.connect();
    await bob.connect();
    await alice.announce("Alice");
    await settle();
    const names = () => [...bob.awareness.getStates().values()].map((s) => (s as { user?: { name: string } }).user?.name);
    expect(names()).toContain("Alice");

    hubs[0]!.leave(ROOM, "alice");
    await settle();
    expect(names()).not.toContain("Alice");
  });

  it("does not advertise the gateway itself as a cursor", async () => {
    const { hubs } = cluster(1);
    const alice = new Client("alice", hubs[0]!);
    await alice.connect();
    const doc = await hubs[0]!.document(ROOM);
    expect(alice.awareness.getStates().has(doc.clientID)).toBe(false);
  });
});
