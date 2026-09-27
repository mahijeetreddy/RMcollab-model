/**
 * Single-job latency, as a person in the room experiences it.
 *
 *   node scripts/latency.mjs [strategy] [runs] [baseUrl]
 *
 * The load test measures throughput under concurrency; this measures the other
 * half of "fast": how long one person waits between pressing upload and seeing
 * the result. Jobs run one at a time, and the clock stops when job_complete
 * arrives on the room's WebSocket - the same event the UI renders from.
 *
 * Run it straight after `docker compose up` to see cold-start cost, and again
 * to see steady state. The worker's own time comes back in job events too, so
 * the report splits "waiting for the model" from "everything else".
 */

const STRATEGY = process.argv[2] ?? "rewrite";
const RUNS = Number(process.argv[3] ?? 12);
const BASE = process.argv[4] ?? "http://localhost:4000";

const SAMPLES = [
  "teh group decided to meet thursday, priya will write teh report",
  "marcus said redis streams is better then kafka cause nobody want zookeeper",
  "the midterm is oct 14 and its 40 percent which is alot",
  "we should of started studying earlier, lena will email the professor",
];

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function main() {
  const { default: WebSocket } = await import("ws").catch(() => ({ default: null }));
  if (!WebSocket) {
    console.error("This script needs `ws`. Run it from the repo root after npm install.");
    process.exit(1);
  }

  const session = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "latency" }),
  }).then((r) => r.json());
  const roomId = session.rooms[0].id;

  // Unlike the load test, the socket stays open: completion is observed the
  // way a browser observes it, not by polling.
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);
  const waiters = new Map();
  let participantId;
  await new Promise((resolve, reject) => {
    ws.on("error", reject);
    ws.on("open", () =>
      ws.send(
        JSON.stringify({ type: "join_session", sessionCode: session.session.code, displayName: "latency" }),
      ),
    );
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "session_joined") {
        participantId = event.participant.id;
        resolve();
      }
      if (event.type === "job_complete") waiters.get(event.jobId)?.(event);
    });
  });

  console.log(`${RUNS} sequential "${STRATEGY}" jobs -> ${BASE}\n`);
  const totals = [];
  const failures = [];

  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    const response = await fetch(`${BASE}/api/rooms/${roomId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        participantId,
        mediaType: "text",
        text: SAMPLES[i % SAMPLES.length],
        strategy: STRATEGY,
      }),
    });
    const { job } = await response.json();
    const event = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ status: "timeout" }), 60_000);
      waiters.set(job.id, (e) => {
        clearTimeout(timer);
        resolve(e);
      });
    });
    const total = performance.now() - t0;
    if (event.status !== "done") failures.push(`${i}: ${event.status} ${event.error ?? ""}`);
    totals.push(total);
    console.log(`  run ${String(i + 1).padStart(2)}  ${total.toFixed(0).padStart(5)} ms  ${event.status}`);
  }
  ws.close();

  console.log(
    `\n  p50 ${percentile(totals, 50).toFixed(0)} ms | p95 ${percentile(totals, 95).toFixed(0)} ms | ` +
      `max ${Math.max(...totals).toFixed(0)} ms | first ${totals[0].toFixed(0)} ms`,
  );
  if (failures.length) {
    console.log(`  ${failures.length} failed:\n    ${failures.join("\n    ")}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
