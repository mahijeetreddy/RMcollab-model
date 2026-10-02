// After a deploy: is the live site really working? One run, end to end, then
// it cleans up after itself (the session it makes is ended and deleted).
//
//   node scripts/smoke.mjs https://rmcollab.example
//   node scripts/smoke.mjs https://localhost --insecure   # Caddy's local certificate
//   npm run smoke -- https://rmcollab.example
//
// Checks, in order: health; the app and its security headers; http -> https;
// a session made and joined over the socket; an upload processed by a worker;
// its signed file link served; CORS refusing another site; metrics and webhooks
// not open to the public; and the session ended. Exits non-zero on any failure,
// naming it, so it can gate a deploy script. Needs Node 22+ (built-in WebSocket).

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
if (!base) {
  console.error("usage: node scripts/smoke.mjs <https://your-domain> [--insecure]");
  process.exit(2);
}
if (args.includes("--insecure")) process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
const https = base.startsWith("https://");
const wsBase = base.replace(/^http/, "ws");

let failed = 0;
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    console.log(`  ok    ${name}${detail ? ` - ${detail}` : ""} (${Date.now() - started} ms)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL  ${name} - ${err instanceof Error ? err.message : err}`);
  }
}
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};
const json = async (path, init) => {
  const res = await fetch(base + path, init);
  const body = await res.json().catch(() => ({}));
  return { res, body };
};

console.log(`smoke test: ${base}`);

await check("health", async () => {
  const { res, body } = await json("/health");
  expect(res.ok && body.db && body.redis, `status ${res.status}, db ${body.db}, redis ${body.redis}`);
  return `replica ${body.replicaId}`;
});

await check("the app loads, with its security headers", async () => {
  const res = await fetch(base + "/");
  const html = await res.text();
  expect(res.ok && html.includes('id="root"'), `status ${res.status}`);
  expect(res.headers.get("x-content-type-options") === "nosniff", "no X-Content-Type-Options: nosniff");
  if (https) expect(res.headers.get("strict-transport-security"), "no Strict-Transport-Security");
});

if (https) {
  await check("plain http redirects to https", async () => {
    const res = await fetch(base.replace("https://", "http://") + "/", { redirect: "manual" });
    expect([301, 302, 307, 308].includes(res.status), `status ${res.status}`);
    expect(res.headers.get("location")?.startsWith("https://"), `to ${res.headers.get("location")}`);
  });
}

let session = null;
let room = null;
let me = null;
let socket = null;
const events = [];

await check("a session is made and joined over the socket", async () => {
  const created = await json("/api/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Smoke test" }),
  });
  expect(created.res.status === 201, `create: status ${created.res.status} ${created.body.error ?? ""}`);
  session = created.body.session;
  room = created.body.rooms[0];
  socket = new WebSocket(`${wsBase}/ws`);
  socket.addEventListener("message", (m) => events.push(JSON.parse(String(m.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("socket would not open")), { once: true });
  });
  socket.send(JSON.stringify({ type: "join_session", sessionCode: session.code, displayName: "Smoke test" }));
  const deadline = Date.now() + 10_000;
  while (!events.some((e) => e.type === "room_state") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  me = events.find((e) => e.type === "session_joined")?.participant?.id;
  expect(me && events.some((e) => e.type === "room_state"), "no session_joined and room_state within 10 s");
  return `over ${wsBase.split(":")[0]}`;
});

let fileUrl = null;
await check("an upload is processed by a worker", async () => {
  expect(me, "no session to upload into");
  const form = new FormData();
  form.append("participantId", me);
  form.append("strategy", "rulebased");
  form.append("file", new Blob(["teh smoke test sat on teh mat"], { type: "text/plain" }), "smoke.txt");
  const up = await fetch(`${base}/api/rooms/${room.id}/media?participantId=${me}`, { method: "POST", body: form });
  expect(up.status === 201, `upload: status ${up.status}`);
  const deadline = Date.now() + 90_000;
  let done = null;
  while (!done && Date.now() < deadline) {
    done = events.find((e) => e.type === "job_complete");
    await new Promise((r) => setTimeout(r, 500));
  }
  expect(done, "no job_complete within 90 s - are the workers up?");
  fileUrl = done.artifacts?.[0]?.url ?? null;
});

await check("its signed file link is served", async () => {
  expect(fileUrl, "no file link from the job");
  if (https) expect(fileUrl.startsWith("https://"), `link is not https: ${fileUrl.split("?")[0]}`);
  const res = await fetch(fileUrl);
  expect(res.ok, `status ${res.status}`);
  expect(res.headers.get("x-content-type-options") === "nosniff", "file served without nosniff");
  const unsigned = await fetch(fileUrl.split("?")[0]);
  expect(unsigned.status === 403, `the same path unsigned answered ${unsigned.status}, not 403`);
});

await check("CORS refuses another site", async () => {
  const res = await fetch(`${base}/api/sessions/${session?.code ?? "X"}`, { headers: { Origin: "https://evil.example" } });
  const allowed = res.headers.get("access-control-allow-origin");
  expect(!allowed || allowed === new URL(base).origin, `Access-Control-Allow-Origin: ${allowed}`);
});

await check("metrics and webhooks are not open to the public", async () => {
  const metrics = await fetch(base + "/api/metrics");
  expect(metrics.status === 404, `/api/metrics answered ${metrics.status} without a token`);
  const hooks = await fetch(`${base}/api/sessions/${session?.code ?? "X"}/webhooks`);
  expect(hooks.status === 404 || hooks.status === 403, `webhooks answered ${hooks.status}`);
});

await check("the session is ended and deleted", async () => {
  expect(session && me, "no session to end");
  const res = await fetch(`${base}/api/sessions/${session.code}?participantId=${me}`, { method: "DELETE" });
  expect(res.status === 204, `end: status ${res.status}`);
  const deadline = Date.now() + 10_000;
  let gone = false;
  while (!gone && Date.now() < deadline) {
    gone = (await fetch(`${base}/api/sessions/${session.code}`)).status === 404;
    if (!gone) await new Promise((r) => setTimeout(r, 300));
  }
  expect(gone, "still there after 10 s");
});

socket?.close();
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
