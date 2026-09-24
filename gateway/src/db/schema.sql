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
