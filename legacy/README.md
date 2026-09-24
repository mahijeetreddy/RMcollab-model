# legacy/

The original RMcollab prototype, kept as a historical reference. A single Express
process with an `ws` broadcast relay, multer disk uploads, and a synchronous
`child_process.exec` shell-out to a Python script for video work.

It is **archival**: nothing imports it, it is not in the npm workspaces, it is not
built, and it never enters a Docker image. The `.js` sources were ported to `.ts`
so the repo is uniformly TypeScript — behaviour and structure are unchanged,
including the reference to `testVideo.py`, which was never committed.

The current system replaces it: `gateway/` (TypeScript HTTP + WebSocket gateway,
Postgres, Redis pub/sub) and `workers/` (Python Celery enhancement strategies),
with `client/` as the React front end.

Typecheck only: `npx tsc --noEmit -p legacy/tsconfig.json`
