CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  code        TEXT UNIQUE NOT NULL,
  name        TEXT,
  created_at  BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS rooms (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_main     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS rooms_session_idx ON rooms(session_id);

CREATE TABLE IF NOT EXISTS participants (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  display_name    TEXT NOT NULL,
  current_room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  connected       BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at       BIGINT NOT NULL,
  last_seen_at    BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS participants_session_idx ON participants(session_id);
CREATE INDEX IF NOT EXISTS participants_room_idx ON participants(current_room_id);

CREATE TABLE IF NOT EXISTS chat_messages (
  id             TEXT PRIMARY KEY,
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  created_at     BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_room_idx ON chat_messages(room_id, created_at);

CREATE TABLE IF NOT EXISTS media_items (
  id                TEXT PRIMARY KEY,
  room_id           TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  uploader_id       TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  media_type        TEXT NOT NULL CHECK (media_type IN ('text','image','audio','video')),
  original_filename TEXT,
  storage_path      TEXT NOT NULL,
  mime_type         TEXT,
  size_bytes        BIGINT,
  created_at        BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS media_items_room_idx ON media_items(room_id, created_at);

CREATE TABLE IF NOT EXISTS enhancement_jobs (
  id                  TEXT PRIMARY KEY,
  media_item_id       TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  media_type          TEXT NOT NULL CHECK (media_type IN ('text','image','audio','video')),
  strategy            TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('queued','processing','done','failed')),
  progress            REAL NOT NULL DEFAULT 0,
  message             TEXT,
  result_storage_path TEXT,
  error               TEXT,
  attempt_count       INT NOT NULL DEFAULT 0,
  created_at          BIGINT NOT NULL,
  started_at          BIGINT,
  completed_at        BIGINT
);
CREATE INDEX IF NOT EXISTS enhancement_jobs_media_idx ON enhancement_jobs(media_item_id);

-- Phase 3 (webhooks). Created up front so the schema has one home.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_session_idx ON webhook_endpoints(session_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            TEXT PRIMARY KEY,
  endpoint_id   TEXT NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  attempt       INT NOT NULL DEFAULT 0,
  status_code   INT,
  error         TEXT,
  latency_ms    INT,
  delivered     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL,
  last_attempt_at BIGINT
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx ON webhook_deliveries(endpoint_id, created_at);

-- migrate.ts replays this whole file on every boot, so later additions are
-- expressed as idempotent ALTERs rather than edits to the CREATE above.
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at BIGINT;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS terminal BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS event_id TEXT;

-- Breakout privacy: a room may carry its own code. Unlocked rooms stay open to
-- everyone in the session; a locked room admits only participants who have
-- presented its code at least once.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS access_code TEXT;

CREATE TABLE IF NOT EXISTS room_members (
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  granted_at     BIGINT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);

-- A job produces one or more named outputs. An enhancing strategy writes a single
-- `enhanced` artifact; a comprehension strategy writes a transcript and a summary,
-- which is why the job's old single result_storage_path could not stay.
CREATE TABLE IF NOT EXISTS job_artifacts (
  id           TEXT PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES enhancement_jobs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  label        TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   BIGINT,
  meta         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_artifacts_job_idx ON job_artifacts(job_id, created_at);

-- Room ownership: whoever created a breakout can reveal its code to share it.
-- Nullable because the main room is created with the session, before any
-- participant record exists.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS created_by TEXT
  REFERENCES participants(id) ON DELETE SET NULL;

-- Room library: artifact text copied into the database so it can be searched.
-- Files stay the source of truth for serving; `body` exists only for search and
-- snippets, and is never selected into job events or room snapshots.
ALTER TABLE job_artifacts ADD COLUMN IF NOT EXISTS body TEXT;
-- The label is weighted above the text, so searching "summary" ranks summaries
-- first. English stemming makes "queue" match "queues"; transcripts in other
-- languages still match exact words, just without stemming.
ALTER TABLE job_artifacts ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(label, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(body, '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS job_artifacts_search_idx ON job_artifacts USING GIN (search);
CREATE INDEX IF NOT EXISTS media_items_room_idx ON media_items(room_id, created_at);

-- Room notes: a Yjs CRDT document per room. Edits append to room_doc_updates
-- (merged in ~400ms batches), and compaction folds them into room_docs.snapshot.
-- Rows are opaque binary updates; order does not matter to a CRDT, so seq is
-- only a compaction watermark, not a replay order.
CREATE TABLE IF NOT EXISTS room_docs (
  room_id       TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  snapshot      BYTEA NOT NULL,
  compacted_seq BIGINT NOT NULL DEFAULT 0,
  updated_at    BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_doc_updates (
  seq        BIGSERIAL PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  data       BYTEA NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS room_doc_updates_room_idx ON room_doc_updates(room_id, seq);

-- Ask the room: each searchable document split into passages small enough to
-- hand to a language model and specific enough to cite. A transcript passage
-- keeps the time its first line is spoken, so a citation can seek the player.
-- `embedding` is filled asynchronously by a worker (snowflake-arctic-embed-m,
-- 768 dimensions); a passage without one is still found by its keywords.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS artifact_passages (
  id          TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES job_artifacts(id) ON DELETE CASCADE,
  ord         INT NOT NULL,
  body        TEXT NOT NULL,
  start_s     REAL,
  embedding   vector(768),
  created_at  BIGINT NOT NULL,
  UNIQUE (artifact_id, ord)
);
ALTER TABLE artifact_passages ADD COLUMN IF NOT EXISTS search tsvector
  GENERATED ALWAYS AS (to_tsvector('english', body)) STORED;
CREATE INDEX IF NOT EXISTS artifact_passages_search_idx ON artifact_passages USING GIN (search);
-- No ANN index on `embedding`, deliberately: every question is scoped to one
-- room, a few hundred passages at most, so an exact scan is both correct and
-- fast. An HNSW index would only pay off at scale, and filtering it by room
-- can return fewer than k rows.
-- Set once an artifact has been split, so the indexer never re-splits one whose
-- text yielded no passages.
ALTER TABLE job_artifacts ADD COLUMN IF NOT EXISTS passages_at BIGINT;

-- A name someone gave an upload. Null means the file name, or for text, a
-- title taken from its first words when it was added.
ALTER TABLE media_items ADD COLUMN IF NOT EXISTS title TEXT;

-- When anyone last did anything in a session. Sessions untouched for
-- SESSION_TTL_DAYS are deleted with everything in them (gateway/src/lifecycle.ts).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_active_at BIGINT;
UPDATE sessions SET last_active_at = created_at WHERE last_active_at IS NULL;
CREATE INDEX IF NOT EXISTS sessions_last_active_idx ON sessions(last_active_at);

-- Notes history: whole-document restore points. Anyone in a room can edit its
-- notes, and anyone can erase them; these are how that is undone. Taken hourly
-- while a room is being edited, before a large deletion, and before a restore.
CREATE TABLE IF NOT EXISTS room_doc_versions (
  id         TEXT PRIMARY KEY,
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  reason     TEXT NOT NULL,
  words      INT NOT NULL,
  state      BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS room_doc_versions_room_idx ON room_doc_versions(room_id, created_at DESC);

-- Removing people. A room's owner can remove someone from it: they are moved
-- out and barred from coming back into that room. Removing someone from the
-- main room removes them from the session. With guest identity this bars that
-- participant, not the person - they could rejoin under a new name with the
-- code - which is why a breakout room can also be locked with a code.
CREATE TABLE IF NOT EXISTS room_bans (
  room_id        TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  banned_at      BIGINT NOT NULL,
  PRIMARY KEY (room_id, participant_id)
);
ALTER TABLE participants ADD COLUMN IF NOT EXISTS removed_at BIGINT;

-- Several documents a room. The room's own notes are document 'main' (so every
-- row written before documents existed already belongs to it); the others are
-- made by people. Uploads always write into 'main'.
CREATE TABLE IF NOT EXISTS room_documents (
  room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id         TEXT NOT NULL,
  title      TEXT NOT NULL,
  is_main    BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT REFERENCES participants(id) ON DELETE SET NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (room_id, id)
);
ALTER TABLE room_docs ADD COLUMN IF NOT EXISTS doc_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE room_docs DROP CONSTRAINT IF EXISTS room_docs_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS room_docs_room_doc_idx ON room_docs(room_id, doc_id);
ALTER TABLE room_doc_updates ADD COLUMN IF NOT EXISTS doc_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS room_doc_updates_doc_idx ON room_doc_updates(room_id, doc_id, seq);
ALTER TABLE room_doc_versions ADD COLUMN IF NOT EXISTS doc_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS room_doc_versions_doc_idx ON room_doc_versions(room_id, doc_id, created_at DESC);

-- Keeping removed people out. Removing someone from a session changes its code;
-- the old one is kept here, so it still brings back a current member who has
-- their participant id (a reload, Recent sessions) but admits nobody new.
CREATE TABLE IF NOT EXISTS retired_session_codes (
  code       TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  retired_at BIGINT NOT NULL
);
-- A waiting room: when on, someone new waits until the owner lets them in.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS waiting_room BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS waiting BOOLEAN NOT NULL DEFAULT FALSE;
