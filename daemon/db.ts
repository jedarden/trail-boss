// SQLite database layer for Trail Boss state
import { Database } from "bun:sqlite";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

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
  // Remove queue rows first (FK references sessions.session_id)
  db.prepare("DELETE FROM queue WHERE session_id = ?").run(sessionId);
  db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
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

// Dequeue any synthetic bootstrap entry whose session_id equals the pane_id
// (but skip if it's already the real session). Called when a real hook fires for a pane.
export function dequeueByPaneId(paneId: string, realSessionId: string): void {
  const now = Date.now();
  // Bootstrap entries have session_id = pane_id
  const stmt = db.prepare(`
    UPDATE queue SET dequeued_at = ?
    WHERE session_id = ? AND session_id != ? AND dequeued_at IS NULL
  `);
  stmt.run(now, paneId, realSessionId);
  // Also clean up the synthetic session row itself
  const del = db.prepare(`DELETE FROM sessions WHERE session_id = ? AND session_id != ?`);
  del.run(paneId, realSessionId);
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

export function getHead(): { id: number; session_id: string; stuck_at: number; skip_cooldown_until: number | null; reason: string } | null {
  const now = Date.now();
  const stmt = db.prepare(`
    SELECT q.id, q.session_id, q.stuck_at, q.skip_cooldown_until, q.reason
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
      AND (q.skip_cooldown_until IS NULL OR q.skip_cooldown_until < ?)
    ORDER BY q.stuck_at ASC
    LIMIT ?
  `);
  return stmt.all(now, limit) as ReturnType<typeof getAllStuck>;
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

// Stuck-direction reconcile: get sessions that are not currently queued
// (for detecting sessions that became stuck while daemon was down)
export function getSessionsNotInQueue(limit: number = 100): Array<{
  session_id: string;
  pane_id: string;
  transcript_path: string;
  cwd: string;
}> {
  const stmt = db.prepare(`
    SELECT s.session_id, s.pane_id, s.transcript_path, s.cwd
    FROM sessions s
    LEFT JOIN queue q ON s.session_id = q.session_id AND q.dequeued_at IS NULL
    WHERE q.session_id IS NULL
    ORDER BY s.last_seen_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as ReturnType<typeof getSessionsNotInQueue>;
}

// Cleanup old dequeued items
export function cleanupQueue(olderThanMs: number = 24 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - olderThanMs;
  const stmt = db.prepare("DELETE FROM queue WHERE dequeued_at < ?");
  stmt.run(cutoff);
}

// Bead database access for starvation diagnostics
// We use the bead CLI to query instead of opening SQLite directly
// because the bead-rs database may have locking/compatibility issues

interface Bead {
  id: string;
  title: string;
  status: string;
  effective_status: string;
  labels: string[];
  assignee: string | null;
  dependencies: Array<{ blocker: string; kind: string }>;
  manual_blocked: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface ExclusionReason {
  bead_id: string;
  title: string;
  reasons: string[];
}

interface StarvationDiagnostic {
  total_open_beads: number;
  pluck_visible_beads: number;
  invisible_beads: ExclusionReason[];
  exclusion_summary: {
    blocked: number;
    manual_blocked: number;
    human: number;
    deferred_assignee: number;
    dependency: number;
  };
  timestamp: string;
}

/**
 * Query the bead database via bead CLI and compute starvation diagnostics.
 *
 * This function:
 * 1. Queries all beads using the bead CLI
 * 2. Applies Pluck's filtering logic (labels, status, assignee, dependencies)
 * 3. Returns counts and detailed exclusion reasons for invisible beads
 */
export function getStarvationDiagnostic(): StarvationDiagnostic {
  const now = new Date().toISOString();

  try {
    // Query all beads using the bead CLI
    const beadJson = execSync("bead list --json", { encoding: "utf-8" });

    // Parse JSON lines (bead list --json outputs one JSON object per line)
    const lines = beadJson.trim().split("\n").filter(line => line.length > 0);
    const allBeads: Bead[] = lines.map(line => JSON.parse(line));

    return computeDiagnostics(allBeads, now);
  } catch (err) {
    throw new Error(`Failed to query beads: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Compute starvation diagnostics from a list of beads.
 */
function computeDiagnostics(beads: Bead[], now: string): StarvationDiagnostic {
  // Count open beads (not done/closed and not in_progress)
  const openBeads = beads.filter(function(bead) {
    const status = bead.status.toLowerCase();
    return !["closed", "done"].includes(status) && status !== "in_progress";
  });

  const totalOpen = openBeads.length;

  // Default exclusion labels from Pluck
  const defaultExcludeLabels = ["deferred", "human", "blocked"];
  const excludeLabelSet = new Set(defaultExcludeLabels.map(l => l.toLowerCase()));

  // Build map of finished beads for dependency checking
  const finishedById = new Map<string, boolean>();
  for (const bead of beads) {
    finishedById.set(bead.id, ["closed", "done"].includes(bead.status.toLowerCase()));
  }

  // Analyze each open bead for exclusion reasons
  const invisibleBeads: ExclusionReason[] = [];
  const exclusionSummary = {
    blocked: 0,
    manual_blocked: 0,
    human: 0,
    deferred_assignee: 0,
    dependency: 0,
  };

  let visibleCount = 0;

  for (const bead of openBeads) {
    const reasons: string[] = [];

    // Check for blocking dependencies
    for (const dep of bead.dependencies) {
      const isBlocking = !dep.kind || dep.kind.toLowerCase() === "blocks";
      if (isBlocking) {
        const blockerFinished = finishedById.get(dep.blocker) ?? false;
        if (!blockerFinished) {
          reasons.push(`dependency:${dep.blocker}`);
          exclusionSummary.dependency++;
        }
      }
    }

    // Check manual_blocked status
    if (bead.manual_blocked) {
      reasons.push("manual_blocked:true");
      exclusionSummary.manual_blocked++;
    }

    // Check for exclusion labels
    for (const label of bead.labels) {
      if (excludeLabelSet.has(label.toLowerCase())) {
        reasons.push(`label:${label}`);
        if (label.toLowerCase() === "blocked") {
          exclusionSummary.blocked++;
        } else if (label.toLowerCase() === "human") {
          exclusionSummary.human++;
        }
      }
    }

    // Check deferred status or label
    if (bead.status.toLowerCase() === "deferred" || bead.labels.map(l => l.toLowerCase()).includes("deferred")) {
      reasons.push("status:deferred");
      exclusionSummary.deferred_assignee++;
    }

    // Check assignee
    if (bead.assignee) {
      reasons.push(`assignee:${bead.assignee}`);
      exclusionSummary.deferred_assignee++;
    }

    // If no exclusion reasons, the bead is visible to Pluck
    if (reasons.length === 0) {
      visibleCount++;
    } else {
      invisibleBeads.push({
        bead_id: bead.id,
        title: bead.title,
        reasons,
      });
    }
  }

  return {
    total_open_beads: totalOpen,
    pluck_visible_beads: visibleCount,
    invisible_beads: invisibleBeads,
    exclusion_summary: exclusionSummary,
    timestamp: now,
  };
}
