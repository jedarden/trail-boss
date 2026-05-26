-- Trail Boss SQLite Schema
-- The session registry and FIFO queue state

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  pane_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,  -- unix timestamp
  last_stuck_at INTEGER,           -- unix timestamp of last Stop/PermissionRequest
  last_stuck_reason TEXT,          -- 'stopped' | 'permission'
  last_message TEXT,               -- last_assistant_message or tool_name+input
  created_at INTEGER NOT NULL      -- unix timestamp
);

CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  stuck_at INTEGER NOT NULL,        -- unix timestamp when stuck (for FIFO ordering)
  reason TEXT NOT NULL,             -- 'stopped' | 'permission'
  skip_cooldown_until INTEGER,      -- unix timestamp; if set, not eligible as head
  dequeued_at INTEGER,              -- set when removed via reconcile/UserPromptSubmit
  created_at INTEGER NOT NULL       -- unix timestamp
);

CREATE INDEX IF NOT EXISTS queue_fifo ON queue (stuck_at ASC) WHERE dequeued_at IS NULL;
CREATE INDEX IF NOT EXISTS queue_session ON queue (session_id);
CREATE INDEX IF NOT EXISTS sessions_pane ON sessions (pane_id);
