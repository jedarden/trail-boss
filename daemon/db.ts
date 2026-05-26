// SQLite database layer for Trail Boss state
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";

const DATA_DIR = process.env.TRAILBOSS_DATA_DIR ?? path.join(process.env.HOME ?? "", ".local/share/trailboss");
const DB_PATH = path.join(DATA_DIR, "trailboss.db");

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA foreign_keys=ON");

// Load schema
const schema = fs.readFileSync(path.join(import.meta.dir, "schema.sql"), "utf-8");
db.exec(schema);

// Session registry operations
export function upsertSession(
  sessionId: string,
  paneId: string,
  cwd: string,
  transcriptPath: string,
  lastStuckAt: number | null,
  lastStuckReason: string | null,
  lastMessage: string | null
): void {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO sessions (session_id, pane_id, cwd, transcript_path, last_seen_at, last_stuck_at, last_stuck_reason, last_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (session_id) DO UPDATE SET
      pane_id = excluded.pane_id,
      cwd = excluded.cwd,
      transcript_path = excluded.transcript_path,
      last_seen_at = excluded.last_seen_at,
      last_stuck_at = COALESCE(excluded.last_stuck_at, sessions.last_stuck_at),
      last_stuck_reason = COALESCE(excluded.last_stuck_reason, sessions.last_stuck_reason),
      last_message = COALESCE(excluded.last_message, sessions.last_message)
  `);
  stmt.run(sessionId, paneId, cwd, transcriptPath, now, lastStuckAt, lastStuckReason, lastMessage, now);
}

export function getSession(sessionId: string): { session_id: string; pane_id: string; cwd: string; transcript_path: string; last_stuck_at: number | null; last_stuck_reason: string | null; last_message: string | null } | null {
  const stmt = db.prepare("SELECT * FROM sessions WHERE session_id = ?");
  return stmt.get(sessionId) as ReturnType<typeof getSession>;
}

export function deleteSession(sessionId: string): void {
  const stmt = db.prepare("DELETE FROM sessions WHERE session_id = ?");
  stmt.run(sessionId);
}

// Queue operations
// Enqueue a session, or update existing entry if already queued (idempotent)
export function enqueue(sessionId: string, reason: string, stuckAt: number): void {
  const now = Date.now();
  // First try to update existing queued entry
  const updateStmt = db.prepare(`
    UPDATE queue
    SET reason = ?, stuck_at = ?, skip_cooldown_until = NULL
    WHERE session_id = ? AND dequeued_at IS NULL
  `);
  const result = updateStmt.run(reason, stuckAt, sessionId);

  // If no rows were updated, insert new entry
  if (result.changes === 0) {
    const insertStmt = db.prepare(`
      INSERT INTO queue (session_id, stuck_at, reason, created_at)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(sessionId, stuckAt, reason, now);
  }
}

export function dequeue(sessionId: string): void {
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE queue SET dequeued_at = ? WHERE session_id = ? AND dequeued_at IS NULL
  `);
  stmt.run(now, sessionId);
}

export function skipHead(sessionId: string, cooldownMs: number): void {
  const now = Date.now();
  const cooldownUntil = now + cooldownMs;
  // Move to tail: update stuck_at to now (so it's last in FIFO) and set cooldown
  const stmt = db.prepare(`
    UPDATE queue
    SET stuck_at = ?, skip_cooldown_until = ?
    WHERE id = (SELECT id FROM queue WHERE dequeued_at IS NULL ORDER BY stuck_at ASC LIMIT 1)
    AND session_id = ?
  `);
  stmt.run(now, cooldownUntil, sessionId);
}

export function getHead(): { id: number; session_id: string; stuck_at: number; skip_cooldown_until: number | null } | null {
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT q.id, q.session_id, q.stuck_at, q.skip_cooldown_until
    FROM queue q
    JOIN sessions s ON s.session_id = q.session_id
    WHERE q.dequeued_at IS NULL
      AND (q.skip_cooldown_until IS NULL OR q.skip_cooldown_until < ?)
    ORDER BY q.stuck_at ASC
    LIMIT 1
  `);
  return stmt.get(now) as ReturnType<typeof getHead>;
}

export function getStuckCount(): number {
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM queue q
    WHERE q.dequeued_at IS NULL
      AND (q.skip_cooldown_until IS NULL OR q.skip_cooldown_until < ?)
  `);
  const result = stmt.get(now) as { count: number };
  return result.count;
}

export function getAllStuck(limit: number = 50): Array<{
  id: number;
  session_id: string;
  pane_id: string;
  cwd: string;
  reason: string;
  last_message: string | null;
  stuck_at: number;
  skip_cooldown_until: number | null;
}> {
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT
      q.id,
      q.session_id,
      s.pane_id,
      s.cwd,
      q.reason,
      s.last_message as last_message,
      q.stuck_at,
      q.skip_cooldown_until
    FROM queue q
    JOIN sessions s ON s.session_id = q.session_id
    WHERE q.dequeued_at IS NULL
    ORDER BY q.stuck_at ASC
    LIMIT ?
  `);
  return stmt.all(now) as ReturnType<typeof getAllStuck>;
}

// Reconcile: get all sessions that might be stuck but need verification
export function getSessionsForReconcile(limit: number = 100): Array<{
  session_id: string;
  transcript_path: string;
  last_stuck_at: number | null;
}> {
  const stmt = db.prepare(`
    SELECT session_id, transcript_path, last_stuck_at
    FROM sessions
    WHERE last_stuck_at IS NOT NULL
    ORDER BY last_stuck_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as ReturnType<typeof getSessionsForReconcile>;
}

// Cleanup old dequeued items
export function cleanupQueue(olderThanMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - olderThanMs;
  const stmt = db.prepare("DELETE FROM queue WHERE dequeued_at < ?");
  stmt.run(cutoff);
}
