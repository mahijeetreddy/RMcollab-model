/**
 * Cross-replica check for the shared notes.
 *
 *   docker compose -f infra/docker-compose.yml up -d --scale gateway=2
 *   docker cp scripts/notes-cross-replica.mjs rmcollab-gateway-1:/app/gateway/
 *   docker exec rmcollab-gateway-1 node notes-cross-replica.mjs
 *
 * Runs inside the compose network so it can reach each gateway replica by its
 * container name - bypassing the load balancer, so the two editors are
 * guaranteed to be on different replicas rather than probably. Everything
 * between them - relay, persistence, presence - has to cross Redis.
 */
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import WebSocket from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const [A, B] = (process.env.REPLICAS ?? "rmcollab-gateway-1,rmcollab-gateway-2").split(",");
const SYNC = 0;
const AWARENESS = 1;
const b64 = (bytes) => Buffer.from(bytes).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

class Editor {
  constructor(name, host) {
    this.name = name;
    this.host = host;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField("user", { name, id: name, color: "#3366cc" });
    this.synced = false;
  }

  async join(sessionCode) {
    this.ws = new WebSocket(`ws://${this.host}:4000/ws`);
    await new Promise((resolve, reject) => {
      this.ws.on("error", reject);
      this.ws.on("open", () =>
        this.ws.send(JSON.stringify({ type: "join_session", sessionCode, displayName: this.name })),
      );
      this.ws.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "room_state") {
          this.roomId = event.roomId;
          resolve();
        }
        if (event.type === "doc") this.receive(event.data);
      });
    });
    this.doc.on("update", (update, origin) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, SYNC);
      syncProtocol.writeUpdate(e, update);
      this.send(e);
    });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    this.send(e);
    await until(`${this.name} to sync`, () => this.synced);
  }

  announce() {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]));
    this.send(e);
  }

  send(encoder) {
    this.ws.send(JSON.stringify({ type: "doc", roomId: this.roomId, data: b64(encoding.toUint8Array(encoder)) }));
  }

  receive(data) {
    const decoder = decoding.createDecoder(new Uint8Array(Buffer.from(data, "base64")));
    const kind = decoding.readVarUint(decoder);
    if (kind === SYNC) {
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, SYNC);
      const step = syncProtocol.readSyncMessage(decoder, reply, this.doc, this);
      if (encoding.length(reply) > 1) this.send(reply);
      if (step === syncProtocol.messageYjsSyncStep2) this.synced = true;
    } else if (kind === AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), this);
    }
  }

  get text() {
    return this.doc.getText("t").toString();
  }

  names() {
    return [...this.awareness.getStates().values()].map((s) => s.user?.name).filter(Boolean);
  }
}

async function replicaOf(host) {
  const r = await fetch(`http://${host}:4000/api/metrics`).then((res) => res.json());
  return r.replicaId ?? r.metrics?.replicaId ?? "?";
}

const results = [];
const check = (label, ok) => {
  results.push([label, ok]);
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
};

const session = await fetch(`http://${A}:4000/api/sessions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "cross-replica notes" }),
}).then((r) => r.json());
const code = session.session.code;

const [idA, idB] = [await replicaOf(A), await replicaOf(B)];
check(`two distinct replicas (${idA} / ${idB})`, idA !== idB);

const alice = new Editor("Alice", A);
const bob = new Editor("Bob", B);
await alice.join(code);
await bob.join(code);

alice.doc.getText("t").insert(0, "Alice on replica A. ");
await until("Bob to see Alice", () => bob.text.includes("Alice on replica A."));
bob.doc.getText("t").insert(bob.text.length, "Bob on replica B.");
await until("Alice to see Bob", () => alice.text.includes("Bob on replica B."));
check("edits cross replicas in both directions", alice.text === bob.text);

// Both type into the same spot before either sees the other.
alice.doc.getText("t").insert(0, "[A]");
bob.doc.getText("t").insert(0, "[B]");
await until("convergence", () => alice.text === bob.text && alice.text.includes("[A]") && alice.text.includes("[B]"));
check("concurrent edits at one position converge across replicas", alice.text === bob.text);

alice.announce();
await until("Bob to see Alice's presence", () => bob.names().includes("Alice"));
check("presence crosses replicas", bob.names().includes("Alice"));

// A third editor, joining through replica B after the fact, gets it all.
await sleep(700);
const late = new Editor("Late", B);
await late.join(code);
await until("the late joiner to catch up", () => late.text === alice.text, 3000).catch(() => undefined);
check("a late joiner on the other replica gets the whole document", late.text === alice.text);

alice.ws.close();
await until("Alice's presence to clear", () => !bob.names().includes("Alice"), 3000).catch(() => undefined);
check("presence clears across replicas when an editor leaves", !bob.names().includes("Alice"));

console.log(`\nfinal text: ${JSON.stringify(alice.text)}`);
for (const e of [bob, late]) e.ws.close();
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
