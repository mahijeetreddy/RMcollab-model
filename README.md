# RMcollab

Collaborative rooms for study groups and seminar teams. Each room has **shared notes that everyone
edits live**, and whatever the group drops in writes itself into them: a lecture recording becomes a
timestamped transcript and a summary, a whiteboard photo becomes typed notes, and action items
arrive as checklists - produced by GPU worker pools and streamed to everyone in the room in real
time.

Rooms are shared workspaces rather than calls: live notes, chat, presence, and a searchable library
the group can return to. Media also runs through swappable enhancement pipelines (GAN upscaling,
learned speech denoising) as standalone tools.

## A quick tour

**The room's notes.** A shared document laid out like a word processor. Each upload gets its own
section - here a summarised meeting, a lecture recording and a whiteboard photo - filled in by the
workers as the analysis finishes. Bob's cursor is live; the outline on the left follows the
headings and uploads.

![Room notes: a shared document with sections written by uploads, a collaborator's live cursor, and a document outline](docs/screenshots/notes.png)

**A whiteboard, read into notes** - seen by a second person, in dark mode. The vision model
transcribes what is written, describes the diagram, keeps exact details (`XAUTOCLAIM`, `91.7`), and
turns the written TODOs into a checklist the room can tick off.

![A whiteboard photo turned into structured notes with an action-item checklist, in dark mode](docs/screenshots/notes-dark-whiteboard.png)

**Transcripts tied to the recording.** Every line is timestamped; clicking a stamp plays the
recording from there, and the line being spoken is highlighted. Summary and transcript sit in tabs,
with copy and download.

![A lecture recording's timestamped transcript under its audio player](docs/screenshots/transcript.png)

**Edits you can see.** A rewrite marks what it changed - removals struck through, additions
highlighted - with a count of edits, so even a light touch-up is visible.

![A rewritten text with its edits marked inline next to the original](docs/screenshots/rewrite-diff.png)

**A library that searches everything the room produced** - summaries, rewrites, image notes and
transcripts. A transcript hit says when in the recording the word is spoken, and opening it jumps
to that line.

![Library search for "gateway" matching a summary, a rewrite, image notes and a transcript at 0:03](docs/screenshots/library.png)

**No accounts.** Start a session, share its six-character code, and split into breakout rooms -
lockable with a room code.

![The landing page, with start-a-session and join-a-session forms](docs/screenshots/landing.png)

<sub>Screenshots come from a live stack and are regenerated with `npm run screenshots`.</sub>

---

## Why this project exists

It's a rebuild of a Master's project, redesigned around the parts that are actually interesting
to engineer:

- **Distributed systems** - a stateless, horizontally-scaled gateway behind a load balancer;
  Postgres as shared source of truth; Redis pub/sub for cross-replica WebSocket fan-out;
  per-media-type task queues that scale independently.
- **Concurrency** - bounded worker pools sized per workload (many cheap text workers, one or
  two GPU-bound video workers), late acknowledgement so a killed worker's job is redelivered
  rather than lost, throttled progress streams.
- **Real-time** - WebSocket rooms with presence, typing indicators, live job progress, and
  reconnect/resync from a server-side snapshot.
- **Webhooks** - job lifecycle events delivered as HMAC-signed HTTP callbacks with exponential
  backoff, a delivery log, and manual replay.
- **Applied AI** - speech-to-text and LLM summarisation behind a provider-agnostic interface, plus
  interchangeable enhancement strategies selectable per upload and comparable side by side.

## Architecture

```
                   +-------+     +-------------+
  browsers <--WS-->| nginx |---->|  gateway    |--enqueue-->  Redis  -->  Celery worker pools
                   |  LB   |     |  (Node/TS)  | (Celery v2         |-- enhance.text   xN
                   | :4000 |     |  stateless, |  protocol)         |-- enhance.image  xN
                   +-------+     |  N replicas)|                    |-- enhance.audio  xN
                                 +------+------+                    +-- enhance.video  x1-2 (GPU)
                                        |                                     |
                                 Postgres (state)                        job events
                                        ^                              (Redis Stream)
                                        |                                     |
                                        +----------- gateway consumer <-------+
                                                            |
                                                   webhook dispatcher
```

**Why a hand-rolled Celery producer?** The gateway is Node and the workers are Python. There is
no maintained Node Celery client (`celery-node` was last published in 2022), so
[`gateway/src/queue/celery.ts`](gateway/src/queue/celery.ts) implements the Celery v2 wire
protocol directly over Redis - verified against the Kombu Redis transport, which LPUSHes a
JSON envelope onto a list keyed by queue name and drains it with BRPOP.

**Why every media type goes through the same queue abstraction** (even text, which is just an
API call): one job model, one retry policy, one progress mechanism. Worker pools then scale
independently per queue based on what the work actually costs.

## From enhancement to comprehension

Enhancement makes media prettier; comprehension makes it useful to a group, which is what a
shared room is actually for. So a job produces **named artifacts** rather than one result: an
enhancing strategy writes a single `enhanced` artifact, `transcribe` writes a `transcript`, and
`summarise` writes a `summary`. Artifacts persist against the room, so they are still there when
the group rejoins.

Measured on the target GPU (RTX 3050, 4GB), Whisper `small` at int8:

|                       |                                                 |
| --------------------- | ----------------------------------------------- |
| Transcription speed   | RTF 0.10-0.12 warm (~10x faster than real time) |
| First job in a worker | RTF ~2.9 - dominated by model load              |
| 30 minute lecture     | ~3 minutes                                      |

The gap between those first two rows is why the model is cached for the life of the worker
process: Celery workers are long-lived, so the load cost is paid once rather than per job. The
cost is a few hundred MB of the shared card held by the audio pool - the same trade the video
pool makes for Real-ESRGAN.

**Denoising before transcription was measured, and it hurts.** The original plan had
enhancement feed comprehension - denoise first so the transcript is cleaner. Scored by word error
rate across noise levels, spectral gating made transcripts slightly worse and DeepFilterNet much
worse (21% -> 67% WER in the noisiest case), despite DeepFilterNet being the better denoiser by
SI-SNR. A recogniser and a listener want different things. So denoising is off by default and
stays an opt-in; the full table is in [`workers/README.md`](workers/README.md).

Segment timings are written inline in the transcript file rather than into artifact `meta`,
because `meta` rides along on every WebSocket job event and room snapshot, and a long recording
has hundreds of segments.

**Any language model, chosen by config.** Strategies call
[`workers/common/llm.py`](workers/common/llm.py) and never import a vendor SDK, so Anthropic and
any OpenAI-compatible gateway (OpenRouter, Together, a local vLLM) are interchangeable through
environment variables. With nothing configured the LLM strategies advertise as unavailable and
text falls back to the offline `rulebased` cleanup, so the product still works with no key at
all. Long transcripts are summarised in parts and merged, so a full lecture does not need to fit
in one request.

**Documents, not before/after.** A comprehension job has nothing to compare against, so its card
shows the original recording above a tabbed Summary / Transcript view. Transcript timestamps
seek the recording and the line being spoken is highlighted as it plays; search narrows the
transcript to matching lines. The summary is model output and therefore untrusted, so it is
parsed into a small Markdown tree that React renders as elements - there is no route from summary
text to HTML, which the tests check with a `<script>` payload rather than trusting a sanitiser.

**Images become notes.** A photo of a whiteboard, slide or page goes to a vision model and
comes back as Markdown - headings, points, diagrams described in a sentence, and an "Action items"
list only if to-dos are actually written. It lands as a `summary` artifact, so the room's notes,
the library and search take it without a new kind. On a generated whiteboard (headings, a diagram,
two red TODOs, a figure) Gemini transcribed every line, kept `XAUTOCLAIM` and `91.7` exactly,
described the diagram as data flowing from gateway to Redis to workers, and turned the TODOs into
action items. Three decisions:

- **A separate `vision` task profile.** The text model is often not a vision model (Groq's gpt-oss
  is not), so images go wherever `LLM_VISION_*` points while text stays where it is. Vision counts
  as available only with a vision model named explicitly, or a Claude key: sending an image to a
  text model fails the job instead of degrading.
- **Downscaled before sending.** Vision models read at around 1,600 px; a 12-megapixel phone photo
  sent whole costs upload time and tokens for detail the model throws away.
- **The default, with a declared fallback.** Reading into notes is the image default, and the
  registry gained `@register(fallback=True)`: without a vision model the GAN upscaler runs, rather
  than whichever module happened to import first.

On a free tier the vision provider may keep what it is sent, which the strategy's description says
and the example `.env` repeats: this is for study material, not photos of people.

**Long recordings get chapters.** Past eight minutes, the summary opens with a table of contents -
`[HH:MM:SS] Topic`, from the transcript's own timestamps. The model finds chapters within each part
of a long transcript; code assembles them. Left to the model, the merge put 10 of 12 chapters in
the first 5 minutes of a 54-minute session (it kept the earliest when trimming) and moved them
below the summary. Code now sorts them, folds repeated neighbours, spreads the twelve across the
whole recording and puts them first - and every timestamp is checked to exist in the source.

**Edits you can see.** A careful rewrite of already-clean prose looks unchanged side by side, so a
text result marks its edits inline - removals struck through, additions highlighted, with a count
of edits and words changed. Paragraphs are aligned first and only changed stretches are diffed word
by word, so a long document stays fast; a size cap swaps an oversized stretch for a whole
replacement rather than freezing the tab. Look-alike characters are treated as equal: a model was
caught swapping ordinary hyphens for non-breaking ones, which a naive diff reports as edits no one
can see.

**A room is worth coming back to.** The Library view lists every document a room has produced
and searches them with Postgres full-text search - a generated, weighted `tsvector` over each
artifact's text with a GIN index, so "pelican" finds "pelicans" and `"fan out" -redis` works as
typed. No search service: at this size the database already does it. Details:

- **Text is copied in once, when a job lands.** The gateway reads each text artifact from shared
  storage as it records the job, so a document is searchable the moment it exists; older rows
  are backfilled at boot. The file stays the source of truth for serving.
- **The text never leaves the database by accident.** Job events and room snapshots select
  artifact columns explicitly, so a three-hour transcript does not ride along on every WebSocket
  frame. An end-to-end test asserts it.
- **Highlights are not HTML.** `ts_headline` marks matches with two control characters that are
  stripped from the text on the way in, so the client renders highlights without ever parsing
  markup from the server.
- **A transcript hit knows when it was said.** The first transcript line matching the query gives
  a timestamp; opening the hit switches to the feed and brings that line into view, without
  starting playback.
- **Private rooms stay private.** The library is guarded like uploading: session membership is
  not enough to read a locked room's documents.

## Swappable strategies

Adding a new approach is **one file and one decorator**, with no changes anywhere else:

```python
@register
class MyEnhancer(BaseEnhancer):
    media_type = "image"
    name = "my-approach"
    label = "My Approach"

    def enhance(self, input_path, output_path, params, progress):
        ...
```

It then appears automatically under "More options" when adding media. See
[`workers/README.md`](workers/README.md).

**People are not shown the strategy list first.** Adding media is a drop zone that takes several
files (or pasted text) at once. The client identifies each item and measures it - word count,
image size, recording length - then proposes the action that suits it in plain language, with the
reason: a long text gets "Summarise", a short one "Polish the writing", a small image "Sharpen &
upscale", a 42-minute recording "Transcribe & summarise - about 5 min". Nothing is sent until the
person clicks; every other strategy stays one click away. The recommendation follows the live
adverts below, so without a vision model an image falls back to upscaling rather than proposing
something that cannot run (`client/src/lib/detect.ts`, `client/src/lib/recommend.ts`).

The browser's guess is a convenience, not a trust boundary. The gateway reads each upload's magic
bytes (`gateway/src/http/sniff.ts`): content it does not recognise is refused with 415, and a file
whose bytes disagree with its declared type - an `.mp4` that is really audio - is routed by what it
actually is.

Strategies declare whether they can actually run (`available()` - an API key, model weights, a
GPU). Workers advertise their live registry into Redis under a TTL heartbeat and the gateway
mirrors it, so what is offered reflects the pools that are genuinely online rather than a list baked
into the code. An unavailable strategy stays visible but greyed out, never wins default
resolution, and if you request one anyway the job reports which strategy ran instead and why.

**Jobs are routed by capability, not by media type.** Each advert carries the queue that reaches
the pool able to run it, and the gateway sends a job there. That is what lets a lecture _video_ be
transcribed by the _audio_ pool: comprehending a video is audio work, and the audio pool is where
Whisper is already loaded. The class lives in the audio package with `media_type = "video"`, so
the audio pool registers and advertises it and the video pool never loads it. The alternative -
transcribing in the video pool - would put a second Whisper on the same 4GB card and queue every
lecture behind upscales in a pool that runs one job at a time.

Three rules keep that honest, each added because something broke without it:

- **A pool advertises only what its own packages define.** Video upscaling imports the image
  Real-ESRGAN module, which registers the image strategies in the video pool as a side effect.
  Advertised, they overwrote the image pool's adverts - last writer wins - and image jobs could be
  routed to the video queue. Ownership is by defining package, not by what happens to be loaded.
- **A pool imports only the packages it serves.** Resolving a video job in the audio pool would
  otherwise import the whole video package, torch and all, into it.
- **One default per media type, merged at the gateway: declared beats fallen-back.** Each pool
  knows only its own registry, so the video pool alone reports `classical` as its default while
  the audio pool declares `comprehend`. The gateway prefers declared-and-available, then
  available, so if the audio pool is down, video degrades to upscaling rather than failing.

The advert shape is checked across both languages by `npm run check:contracts`, like the job
payload and job events: routing now depends on it.

| Media | Strategies                                                                                                                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| text  | `rulebased` (deterministic offline cleanup - no key, no network) / `rewrite`, `summarise` (any configured language model)                                                                                     |
| image | **`notes`** (whiteboard, slide or page read into notes by a vision model) / `realesrgan` (GAN 4x super-resolution; the fallback when no vision model is configured) / `classical` (gamma + CLAHE, sub-second) |
| audio | **`comprehend`** (transcript + summary) / `transcribe` (Whisper speech-to-text) / `spectral` (noise gating) / `deepfilternet` (learned speech enhancement)                                                    |
| video | **`comprehend`** (transcript + summary from the soundtrack; runs in the audio pool) / `classical` (per-frame, ~6ms/frame) / `realesrgan` (per-frame GAN, opt-in and frame-budgeted)                           |

Measured on the same card: Real-ESRGAN upscales 1280x720 to 5120x2880 in 58s at 756MB peak
VRAM - it runs **tiled**, because a naive full-frame pass OOMs a 4GB card. Audio denoising
measures +9.6 dB (spectral) and +16.7 dB (DeepFilterNet) SI-SNR improvement on a noisy 12s clip,
at well under real time.

Model weights download on first use into a named volume and are verified by size and SHA-256,
so a truncated download fails loudly instead of producing garbage.

## Room notes: one shared document, edited live

Each room has a notes page that everyone in it edits at once, laid out like a word processor -
a page on a canvas, a formatting toolbar, a document outline - with each person's cursor and name
visible. It is where the room's understanding accumulates: **every upload writes into it.** A file
gets its own section the moment it is accepted, and the section fills with the analysis when the
job finishes - a summary's headings and points, its action items as a real checklist, a
transcript's opening lines, a rewrite's text - live, for everyone in the room.

**Concurrent editing is a CRDT, not last-write-wins.** Two people typing into the same sentence
at the same moment must both keep their words; saving whole-document snapshots would drop one.
The document is a [Yjs](https://github.com/yjs/yjs) CRDT with a TipTap editor bound to it, so
concurrent edits merge deterministically on every client without a central lock.

How it runs across a horizontally scaled gateway:

- **One transport.** Sync and presence travel as y-protocols messages (the y-websocket wire
  format) inside the existing JSON socket, so the room access check that guards chat and uploads
  guards the document too - a locked room's notes are exactly as private as the room.
- **Every replica holds a copy while it has editors, and Redis carries the edits.** A replica
  applies a local edit, publishes it, and - following the same publish-then-deliver rule as the
  rest of the room - every replica applies what arrives and forwards it to its own editors, minus
  the author. No ordering or de-duplication is needed: CRDT merges are commutative and idempotent.
- **A replica's copy lives exactly as long as its Redis subscription.** Kept any longer, it would
  miss edits made elsewhere and hand the next joiner a stale document. When a replica loads a
  room it also re-reads storage once after a batch window, catching an edit another replica had
  published but not yet saved.
- **Keystrokes are batched.** Updates merge into one row per 400 ms per room instead of one per
  key: a whole cross-replica editing session measured at two rows. The window cannot lose work:
  every editor holds the full document, and the sync handshake on reconnect sends the server
  exactly what it is missing - an edit survives even a replica dying before it saved.
- **Compaction happens in the database.** Batches fold into a snapshot under a transaction-scoped
  advisory lock, from what is stored rather than any replica's memory. It deletes exactly the rows
  it merged, never "everything up to seq N": a sequence number is taken at insert but visible only
  at commit, so another replica's batch can hold a lower number and still be unmerged.
- **Presence is ephemeral, and answered.** Cursors are never stored. When a newcomer appears,
  existing editors re-announce immediately rather than on the 15 s renewal, so someone joining
  through another replica sees everyone at once. Colours from other browsers are untrusted and
  only a plain `#rrggbb` is ever put in a style.
- **Undo is yours alone.** History is the CRDT's per-user undo manager: undo takes back your own
  typing, never a collaborator's.

**The AI is a collaborator that only adds.** The gateway writes into the same CRDT the editors
do, as one more peer. Rules it keeps:

- **A placeholder is saved before the job is queued.** A job's completion can be handled by a
  different replica, which - if nobody in the room is connected to it - loads the notes from
  storage. Had the placeholder still been in a save batch, that replica would not find it and the
  upload would get two sections. So this one write is saved synchronously; everything else batches.
- **An untouched placeholder is replaced; anything a person typed stays,** with the results added
  after it. **A section a person deleted stays deleted:** the writer records which uploads it has
  placed a section for, in the same document, so "missing" can be told apart - never written,
  versus removed on purpose.
- **Filled exactly once, cluster-wide.** Completion is driven by the job-event consumer group, and
  only the event that moves a job to done or failed gets past the idempotent update - a redelivery
  finds the job already terminal.
- **Progress is not written into the document.** It ticks several times a second; each tick would
  be a CRDT update and a stored row. The section reads live progress from room state instead,
  which every client already has.
- **The document schema is a contract.** The editor's collaboration binding does not show an
  element its schema rejects - it deletes it. So the section builder lives in `shared`, used by the
  gateway, and a client test loads everything it can produce into the real editor schema and fails
  if anything would be dropped.

The editor is split out of the main bundle and loaded on first use (66 KB vs 168 KB gzipped).
`npm run check:notes-replicas` runs two editors against two gateway replicas directly, bypassing
the load balancer so they are guaranteed to be on different replicas.

## Access and security

- **Private breakout rooms.** A session code gets you into a session; a room can additionally be
  locked with its own code when it is created. A locked room admits only participants who have
  presented its code, and remembers them so a reconnect does not ask again. The room's creator
  is marked as its owner and can reveal the code to share it. The code is never included in any
  room listing - rooms carry only an `isLocked` flag.
- **Presigned media URLs.** Uploaded and generated media are served to `<img>`/`<video>` tags,
  which cannot send an auth header, so every file URL carries an HMAC signature and an expiry
  (the S3 approach). A bare or tampered path returns 403.
- **SSRF-safe webhooks.** Outbound webhook URLs are validated against private, loopback and
  link-local ranges by resolving the hostname rather than pattern-matching it.
- **Guest identity.** There are no accounts: a participant id is effectively a bearer token, and
  the owner-only endpoints are exactly as strong as that id. This is a deliberate scope choice
  for a classroom tool, not an oversight.

**Cross-language contracts are enforced, not remembered.** Worker job events are produced in
Python and consumed in TypeScript. `npm run check:contracts` parses both definitions and fails
with a specific diff if they drift - including the deliberate camelCase/snake_case split between
the two payloads.

## Webhooks

Job lifecycle events are delivered to registered endpoints as signed HTTP callbacks by a
dispatcher that runs as its own container - same image as the gateway, different entrypoint, so
it reuses the DB and shared code while scaling independently. It reads the job-event stream
under its own Redis consumer group, so gateway and dispatcher each see every event.

```
POST /api/sessions/:code/webhooks   { url }   -> returns the signing secret once
GET  /api/webhooks/:id/deliveries             -> every attempt: status, latency, error
POST /api/webhooks/deliveries/:id/replay      -> re-queue a failed delivery
```

Signature: `X-RMcollab-Signature: t=<unix_seconds>,v1=<hex HMAC-SHA256>` over `"<t>.<body>"`.
The timestamp is inside the signed string so a receiver can reject a replayed-but-valid body by
age - signing the body alone would leave captured requests valid forever.

Retries use exponential backoff with jitter, bounded at 5 attempts, and are scheduled in a Redis
sorted set rather than an in-process timer - so pending retries survive a dispatcher restart
instead of being silently dropped. 5xx/429/network errors retry; other 4xx are terminal, because
a receiver returning 400 will return 400 again.

## Stack

| Layer         | Choice                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| Client        | React 18, TypeScript, Vite                                                                           |
| Edge          | nginx - load balancing across gateway replicas, WebSocket upgrade                                    |
| Gateway       | Node 20, Express, `ws`, ioredis, `pg`                                                                |
| Workers       | Python 3.11, Celery, Redis broker                                                                    |
| Models        | faster-whisper, Real-ESRGAN (RRDBNet), DeepFilterNet; LLM via Anthropic or any OpenAI-compatible API |
| State         | Postgres 16                                                                                          |
| Bus           | Redis - pub/sub (fan-out), Streams (job events), lists (task queues)                                 |
| Orchestration | Docker Compose, NVIDIA GPU passthrough                                                               |

## Running it

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build
```

The stack runs with no keys at all. To enable the LLM strategies (`rewrite`, `summarise`), set
**either** `ANTHROPIC_API_KEY`, **or** `LLM_BASE_URL` + `LLM_API_KEY` + `LLM_MODEL` for any
OpenAI-compatible gateway. `.env.example` documents both.

- App: http://localhost:5173
- API (via the load balancer): http://localhost:4000 (`/health`, `/api/strategies`, `/api/metrics`)

The image, audio and video pools reserve an NVIDIA GPU. On a machine without one, remove the
`deploy.resources` block from `x-ml-worker` in `infra/docker-compose.yml` - the reservation is a
hard requirement for the container to start, though every strategy itself falls back to CPU.

## Choosing a model

Free models were compared on a 54-minute study-group transcript with twelve facts planted at the
start, middle and end - dates, a room, a grade weight, a measured figure, three action items with
owners, two open questions - plus two traps: an idea the group rejects and a number someone
retracts. Each summary was scored for facts kept, then read for anything stated wrongly.

| Model (free tier)        | Setup                         | Facts kept     | Errors found by reading                                                   | Time   |
| ------------------------ | ----------------------------- | -------------- | ------------------------------------------------------------------------- | ------ |
| **Gemini 3.5 Flash**     | whole transcript, one request | **12, 12, 12** | none                                                                      | 19-30s |
| Gemini 3 Flash (preview) | whole transcript, one request | 11, 11, 11     | inverted a fact once (said the system _uses_ the outbox pattern it lacks) | 8-20s  |
| Groq gpt-oss-120b        | 5 parts, merged               | 9              | the same inversion; contradicted itself on delivery guarantees            | 122s   |
| Groq gpt-oss-120b        | whole transcript              | -              | rejected: the free tier caps a single request at 8K tokens                | -      |
| Gemini 3.8 / 3.7 Flash   | whole transcript              | -              | unavailable: 503 through every retry, on two attempts                     | -      |

What the measurements changed:

- **Merging loses facts.** The same Groq model kept 8 of 12 with the original prompts and 9 with
  prompts that require every date, number and owner to survive the merge. The single-request
  runs kept them all. So `LLM_CHUNK_CHARS` is a per-provider setting: as large as the provider's
  context and quota allow.
- **Free tiers throttle and shed load routinely.** Groq answered 429 nine times in one summary;
  Gemini answered 503 for minutes at a time. Calls retry on 429 and 5xx with jittered exponential
  backoff and honour `Retry-After`, and a wait longer than a minute - a daily cap - fails fast
  instead of holding a worker.
- **Reasoning models can spend the whole budget thinking.** A capped Gemini call came back with
  no text and `finish_reason: length`; that now fails with an error naming `LLM_MAX_TOKENS`.
- **Keyword scoring is not enough.** One model scored 11/12 while stating a fact backwards, which
  only reading caught.

The default is Gemini 3.5 Flash, with a caveat that decides where it is appropriate: Google may use
free-tier prompts for training and human reviewers may read them, and its terms ask for no personal
data. That is fine for a demo on your own recordings and wrong for anyone else's. Groq contractually
does not train on inputs, so it is the choice when privacy outranks summary quality. Either is a
change to `.env` only; `.env.example` has both with their measured settings.

These are single-transcript results from September 2026 on synthetic speech-like text, and free
model line-ups change month to month.

### Latency: where a rewrite's time went

A rewrite is the interaction where someone sits waiting, so it was measured end to end - upload to
`job_complete` on the room's WebSocket - with `npm run latency` (12 sequential jobs, worker freshly
restarted, Groq gpt-oss-120b):

|                            | first job | p50    | worst    |
| -------------------------- | --------- | ------ | -------- |
| Before                     | 1,833 ms  | 798 ms | 2,194 ms |
| After                      | 662 ms    | 737 ms | 1,192 ms |
| After, following 45 s idle | 680 ms    | 514 ms | 680 ms   |

The finding that mattered: **opening the first connection to the provider took 2.8-3.2 s per worker
process** (SDK import, DNS, TCP, TLS). Celery runs four pool processes, so each one's first job paid
it - the "sometimes 4 seconds" rewrite. Three decisions followed:

- **Warm at process start, off the boot path.** Each pool child imports the SDK and opens its
  connection in a background thread as it starts (`llm.warm`), so no user's job pays for it. It is
  a thread because Celery kills a child that is slow to report ready, and a provider that is down
  at boot must not take workers with it.
- **One client per endpoint per process, kept alive.** A client used to be built per call - a
  fresh handshake every time - and httpx drops idle connections after 5 s anyway. Clients are now
  cached per process and hold connections for 120 s, so a rewrite after a quiet minute reuses
  one. Caches are cleared in each forked child so a socket never crosses a fork.
- **Task profiles.** Tasks want different things: a rewrite is short and interactive, a summary long
  and read closely. `LLM_<TASK>_<SETTING>` overrides any setting for one task - model, reasoning
  effort, output cap, even the provider - falling back to the shared `LLM_*`. Rewrites run at
  `reasoning_effort=low`: about 30 output tokens instead of 115-190, and roughly half the call time.

What is left is mostly outside the process: Groq's own server timing showed 0.3 s queued against
0.09 s of compute on the free tier, and the pipeline (upload, Redis, stream, WebSocket) adds
100-200 ms.

## Scaling out

The gateway holds no room state of its own - Postgres is the source of truth and Redis pub/sub
fans events between replicas - so it scales horizontally. nginx publishes port 4000 and
round-robins across however many replicas are running, deliberately without sticky sessions: if
two browsers land on different replicas and still see each other, the fan-out is genuinely
working rather than accidentally co-located.

```bash
npm run scale        # 2 gateway replicas + 3 text workers
npm run loadtest     # 60 jobs at concurrency 10; args: [jobs] [concurrency] [baseUrl]
```

Measured on the dev box with 2 gateways and 3 text workers:

|                    |                                  |
| ------------------ | -------------------------------- |
| Enqueue throughput | 91.7 jobs/s (400 jobs, 0 failed) |
| Enqueue latency    | p50 457ms, p95 634ms             |
| Queue drain        | 400 jobs in 6.3s                 |
| LB distribution    | 6/6 across 2 replicas            |

Cross-replica behaviour is verified, not assumed: with sockets pinned to different gateways,
chat, presence, typing indicators and job progress all arrive on both.

`GET /api/metrics` reports queue depth per media type, which worker pools are advertising, job
counts by status, and the replica that answered. The **Cluster** panel in the app header polls
it - the "gateway replicas seen" counter climbing to 2 is the horizontal-scale claim made
visible.

## Testing

Three layers, from fastest to most real:

| Layer               | Command                        | Needs                                         | Covers                                                                                                                                |
| ------------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (TS)           | `npm test`                     | Node 20                                       | gateway (Celery wire format, SSRF guard, signing, storage, params), client (reducer, event guards), cross-language contract check     |
| Unit (Python)       | `npm run test:workers`         | `pip install -r workers/requirements-dev.txt` | strategy registry, LLM provider selection, event throttling, comprehension pipeline                                                   |
| End to end          | `npm run test:e2e`             | the stack running (`docker compose ... up`)   | real browsers and sockets against the live stack: fan-out, locked rooms, signed URLs, GPU enhancement, transcription, co-edited notes |
| Cross-replica notes | `npm run check:notes-replicas` | `--scale gateway=2`                           | two editors pinned to different gateway replicas: edits, concurrent edits, late joiners and presence all crossing Redis               |

`npm run typecheck` type-checks every TypeScript package. Python tests marked `ml` need the GPU
image's dependencies and skip themselves elsewhere, so the suite runs anywhere. CI
(`.github/workflows/ci.yml`) runs both unit layers on every push.

The end-to-end suite is a standalone package, not a workspace, so Playwright never ends up in a
production image. First run:

```bash
cd e2e && npm install && npm run install-browsers
```

The unit tests found two real bugs when they were written: an SSRF bypass, where
`http://[::ffff:169.254.169.254]/` reached the cloud metadata address because Node rewrites
IPv4-mapped IPv6 into hex form, and an event guard that accepted `toString` as a frame type.

## Roadmap

**Foundation** - complete.

|     | Scope                                                               | Status |
| --- | ------------------------------------------------------------------- | ------ |
| 1   | Distributed skeleton - rooms, chat, presence, uploads, job pipeline | done   |
| 2   | Strategy framework + text strategies                                | done   |
| 3   | Webhooks - HMAC signing, retries/backoff, delivery log, replay      | done   |
| 4   | Image enhancement - Real-ESRGAN (tiled) + classical baseline        | done   |
| 5   | Audio enhancement - spectral gating, DeepFilterNet                  | done   |
| 6   | Video enhancement - per-frame pipeline, ffmpeg remux, fit-to-budget | done   |
| 7   | Scale-out + observability - load balancer, metrics, load test       | done   |

**Comprehension** - in progress.

|     | Scope                                                                                        | Status |
| --- | -------------------------------------------------------------------------------------------- | ------ |
| 1   | Artifact model - one job, many named outputs                                                 | done   |
| 2   | Transcription - faster-whisper, cached model                                                 | done   |
| 3   | Summarisation - provider-agnostic LLM, chunk-and-reduce                                      | done   |
| 4   | Audio comprehension - transcribe -> summarise in one job                                     | done   |
| 5   | Client - transcript and summary views instead of before/after panes                          | done   |
| 6   | Room library - browse and search everything a room has accumulated                           | done   |
| 7   | Video comprehension - lecture video to transcript + summary, via capability routing          | done   |
| 8   | Room notes - a CRDT document the whole room edits live, across gateway replicas              | done   |
| 9   | Uploads write into the notes - a section per upload, live placeholders, provenance           | done   |
| 10  | Images read into notes (vision model), chapters for long recordings, rooms open on the notes | done   |
| 11  | Ask the room - questions answered from everything in its notes and transcripts, with sources | next   |

Not planned: live audio/video calling (a deliberate scope cut - rooms are workspaces, not calls),
and user accounts (groups return by session code; "my rooms across devices" needs real identity).
