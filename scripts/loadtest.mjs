/**
 * Concurrent-upload load test.
 *
 *   node scripts/loadtest.mjs [jobs] [concurrency] [baseUrl]
 *
 * Fires N text-enhancement jobs through the gateway at a fixed concurrency and
 * reports enqueue latency plus end-to-end completion time, polling job state
 * rather than holding N WebSockets open (the point is to load the queue, not the
 * socket layer). Text is used because it is the only pipeline that is not
 * GPU-serialised, so the queue itself is what gets exercised.
 */

const TOTAL = Number(process.argv[2] ?? 60);
const CONCURRENCY = Number(process.argv[3] ?? 10);
const BASE = process.argv[4] ?? "http://localhost:4000";

const SAMPLE = "teh  quick brown fox   jumps over the lazy dog .it dont matter";

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

async function main() {
  const session = await fetch(`${BASE}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "loadtest" }),
  }).then((r) => r.json());
  const room = session.rooms[0];

  // A participant is required to upload; the WS handshake is the only way to
  // mint one, so borrow a socket briefly and then drop it.
  const { default: WebSocket } = await import("ws").catch(() => ({ default: null }));
  if (!WebSocket) {
    console.error("This script needs `ws`. Run it from the repo root after npm install.");
    process.exit(1);
  }
  const participantId = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws`);
    const timer = setTimeout(() => reject(new Error("WS handshake timed out")), 10_000);
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === "session_joined") {
        clearTimeout(timer);
        ws.close();
        resolve(event.participant.id);
      }
    });
    ws.on("open", () =>
      ws.send(
        JSON.stringify({
          type: "join_session",
          sessionCode: session.session.code,
          displayName: "loadtest",
        }),
      ),
    );
    ws.on("error", reject);
  });

  console.log(`${TOTAL} jobs at concurrency ${CONCURRENCY} -> ${BASE}`);

  const enqueueMs = [];
  const jobIds = [];
  const failures = [];
  let next = 0;
  const started = Date.now();

  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= TOTAL) return;
      const t0 = Date.now();
      try {
        const res = await fetch(`${BASE}/api/rooms/${room.id}/media`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            participantId,
            mediaType: "text",
            text: `${SAMPLE} #${index}`,
            strategy: "rulebased",
          }),
        });
        if (!res.ok) {
          failures.push(`HTTP ${res.status}`);
          continue;
        }
        const body = await res.json();
        enqueueMs.push(Date.now() - t0);
        jobIds.push(body.job.id);
      } catch (cause) {
        failures.push(cause instanceof Error ? cause.message : "request failed");
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const enqueueElapsed = Date.now() - started;

  console.log(`\nenqueue: ${jobIds.length} accepted, ${failures.length} failed`);
  console.log(`  wall ${(enqueueElapsed / 1000).toFixed(2)}s`);
  console.log(`  throughput ${(jobIds.length / (enqueueElapsed / 1000)).toFixed(1)} jobs/s`);
  console.log(
    `  latency p50 ${percentile(enqueueMs, 50)}ms  p95 ${percentile(enqueueMs, 95)}ms  max ${Math.max(...enqueueMs, 0)}ms`,
  );

  process.stdout.write("\ndraining");
  const drainStart = Date.now();
  let metrics = null;
  while (Date.now() - drainStart < 120_000) {
    metrics = await fetch(`${BASE}/api/metrics`).then((r) => r.json());
    const depth = metrics.queues.reduce((sum, q) => sum + q.depth, 0);
    if (depth === 0 && metrics.jobs.processing === 0) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(` done in ${((Date.now() - drainStart) / 1000).toFixed(1)}s`);
  console.log(`  jobs: ${JSON.stringify(metrics?.jobs ?? {})}`);
  if (failures.length > 0) console.log(`  failures: ${[...new Set(failures)].join(", ")}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
