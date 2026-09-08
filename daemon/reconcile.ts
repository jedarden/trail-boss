// Transcript reconcile loop: the transcript JSONL is ground truth
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { getSession, dequeue, getSessionsForReconcile, upsertSession, enqueue, getSessionsNotInQueue, BEAD_LIST_LIMIT } from "./db.ts";

// Full path because the systemd service has no ~/.local/bin in PATH.
// Overridable so tests can point this at a stub CLI (TRAILBOSS_BEAD_BIN).
const BEAD_BIN = process.env.TRAILBOSS_BEAD_BIN || "/home/coding/.local/bin/bead";

// Real Claude Code transcript entry shape
interface TranscriptEntry {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  timestamp?: string | number; // ISO-8601 string or epoch-ms number
  // Non-message types: attachment, queue-operation, last-prompt, etc.
}

// Parse timestamp from ISO string or pass through number
function parseTimestamp(ts: string | number | undefined): number {
  if (ts === undefined) return 0;
  if (typeof ts === "number") return ts;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? 0 : parsed;
}

// Check if a transcript has advanced past the last stuck point
// Returns true if the session should be dequeued
export function hasTranscriptAdvanced(
  transcriptPath: string,
  lastStuckAt: number
): boolean {
  if (!fs.existsSync(transcriptPath)) {
    return false; // No transcript yet; can't determine
  }

  // Read the last few lines (most recent entries)
  const content = fs.readFileSync(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  // Check the last 5 entries for any user message or new assistant turn after last_stuck_at
  const checkCount = Math.min(5, lines.length);
  for (let i = lines.length - checkCount; i < lines.length; i++) {
    try {
      const entry: TranscriptEntry = JSON.parse(lines[i]);
      const entryTime = parseTimestamp(entry.timestamp);

      // Only consider entries strictly newer than the stuck time
      if (entryTime <= lastStuckAt) continue;

      // User message means they answered directly in the pane
      // Real format: type="user" with message.role="user"
      if (entry.type === "user" || entry.message?.role === "user") {
        return true;
      }

      // New assistant turn means the session progressed
      // Real format: type="assistant" with message.role="assistant"
      if (entry.type === "assistant" || entry.message?.role === "assistant") {
        return true;
      }
    } catch {
      continue; // Skip malformed lines
    }
  }

  return false;
}

// Main reconcile sweep: check all sessions and dequeue those that advanced
export function reconcile(): { dequeued: number; checked: number } {
  const sessions = getSessionsForReconcile(100);
  let dequeued = 0;

  for (const sess of sessions) {
    if (!sess.last_stuck_at) continue;

    const advanced = hasTranscriptAdvanced(sess.transcript_path, sess.last_stuck_at);
    if (advanced) {
      dequeue(sess.session_id);
      dequeued++;
    }
  }

  return { dequeued, checked: sessions.length };
}

// Run reconcile periodically
export function startReconcileLoop(intervalMs: number = 5000): void {
  console.log(`[reconcile] started (interval ${intervalMs}ms)`);
  setInterval(() => {
    const result = reconcile();
    if (result.dequeued > 0) {
      console.log(`[reconcile] dequeued ${result.dequeued}/${result.checked} sessions`);
    }
  }, intervalMs);
}

// Bead starvation detection and recovery
interface StarvationDiagnostic {
  timestamp: string;
  workspace: string;
  open_beads: number;
  ready_beads: number;
  excluded_beads: number;
  exclusion_reasons: string[];
  recovered: boolean;
  recovery_attempts: string[];
  error?: string;
}

// One bead as returned by `bead list --json` (JSONL, one object per line).
// Only the fields the exclusion classifier reads are declared; the CLI emits more.
interface BeadRecord {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  manual_blocked?: boolean;
  dependencies?: Array<{ blocker: string; kind: string }>;
  notes?: string | null;
}

// One line of .beads/heartbeats.jsonl — worker liveness, appended by the fleet
// harness. Append-only, so a worker's most recent entry is its last line.
interface HeartbeatEntry {
  worker: string;
  state: string;
  ts: string;
  last_strand?: string | null;
}

// One line of .beads/events.jsonl — claim/dispatch audit events. These are the
// mechanical link between the two naming schemes this workspace uses: beads
// carry Claude session assignees (`claude-code-*`) while heartbeats name fleet
// workers (`glm-*`), and a claim event names both for the same bead.
interface BeadEventEntry {
  bead?: string;
  event?: string;
  worker?: string;
  ts?: string;
}

// The mechanically-derived reason a bead is not on the ready frontier.
// `known` is false only when every field the classifier reads came back
// unremarkable — that residue is exactly what `alert:starvation:unknown`
// exists for.
export interface ExcludedBeadClassification {
  bead_id: string;
  title: string;
  status: string;
  assignee: string | null;
  causes: string[];
  known: boolean;
}

// Parse JSONL defensively: malformed lines are skipped, not fatal — the
// heartbeat and event files are runtime append logs, not contracts.
function parseJsonl<T>(content: string): T[] {
  const out: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch {
      continue;
    }
  }
  return out;
}

// Worker -> most recent heartbeat. Read on every starvation detection, so it
// tolerates the file not existing yet (fresh workspace).
export function loadLastHeartbeatByWorker(filePath: string): Map<string, HeartbeatEntry> {
  const byWorker = new Map<string, HeartbeatEntry>();
  if (!fs.existsSync(filePath)) return byWorker;
  try {
    for (const entry of parseJsonl<HeartbeatEntry>(fs.readFileSync(filePath, "utf-8"))) {
      if (entry?.worker) byWorker.set(entry.worker, entry);
    }
  } catch (err) {
    console.error("[starvation] failed to read heartbeats:", err);
  }
  return byWorker;
}

// Bead id -> worker that most recently claimed it. Assignee names and
// heartbeat worker names never match in this workspace (verified 2026-09-08:
// 21 distinct assignees, all `claude-code-*`; heartbeat workers, all `glm-*`),
// so the claim event is how an in_progress bead finds the heartbeat to report.
export function loadLastClaimerByBead(filePath: string): Map<string, BeadEventEntry> {
  const byBead = new Map<string, BeadEventEntry>();
  if (!fs.existsSync(filePath)) return byBead;
  try {
    for (const entry of parseJsonl<BeadEventEntry>(fs.readFileSync(filePath, "utf-8"))) {
      if (entry?.event === "claim" && entry.bead && entry.worker) byBead.set(entry.bead, entry);
    }
  } catch (err) {
    console.error("[starvation] failed to read bead events:", err);
  }
  return byBead;
}

// Compact human age for a heartbeat: "42s", "7m", "3h", "12d".
function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

const FINISHED_STATUSES = new Set(["closed", "done"]);

// Classify one excluded bead's invisibility cause from bead data alone — no
// human judgment, every cause read from fields that already exist.
// Precedence: manual_blocked is deliberate and ends the classification; an
// in_progress bead reports its worker's heartbeat; an open bead reports a
// dead-assignee candidate and/or its unclosed blockers.
export function classifyExcludedBead(
  bead: BeadRecord,
  statusById: Map<string, string>,
  heartbeatByWorker: Map<string, HeartbeatEntry>,
  claimerByBead: Map<string, BeadEventEntry>,
  nowMs: number
): ExcludedBeadClassification {
  const status = (bead.status ?? "").toLowerCase();
  const assignee = bead.assignee && bead.assignee !== "null" ? bead.assignee : null;
  const base: ExcludedBeadClassification = {
    bead_id: bead.id,
    title: bead.title,
    status,
    assignee,
    causes: [],
    known: true,
  };

  // (d) manual_blocked: the flag is deliberate — record it and skip the dig.
  if (bead.manual_blocked) {
    base.causes = ["manually blocked (deliberate flag; not classified further)"];
    return base;
  }

  // (a) in_progress: report the worker's most recent heartbeat, state and age.
  // The direct assignee->worker lookup rarely matches in this workspace (see
  // loadLastClaimerByBead), so fall back to whoever claimed the bead.
  if (status === "in_progress") {
    const claimedBy = claimerByBead.get(bead.id);
    const worker = (assignee && heartbeatByWorker.has(assignee) ? assignee : null)
      ?? (claimedBy && heartbeatByWorker.has(claimedBy.worker) ? claimedBy.worker : null);
    if (worker) {
      const hb = heartbeatByWorker.get(worker)!;
      const ageMs = nowMs - parseTimestamp(hb.ts);
      base.causes = [`in_progress: worker ${worker} last heartbeat state=${hb.state} ${formatAge(ageMs)} ago`];
    } else if (assignee) {
      base.causes = [`in_progress assigned to ${assignee}; no heartbeat recorded for that worker`];
    } else {
      base.causes = ["in_progress with no assignee and no recorded heartbeat"];
    }
    return base;
  }

  // (b) open with an assignee: nothing will claim it — dead-assignee candidate.
  if (assignee) {
    base.causes.push(`open but assigned to ${assignee} (dead-assignee candidate)`);
  }

  // (c) blocking dependencies: each unclosed blocker, with its status.
  for (const dep of bead.dependencies ?? []) {
    if (dep.kind && dep.kind !== "blocks") continue;
    const blockerStatus = statusById.get(dep.blocker)?.toLowerCase() ?? "unknown";
    if (!FINISHED_STATUSES.has(blockerStatus)) {
      base.causes.push(`blocked by ${dep.blocker} (${blockerStatus})`);
    }
  }

  if (base.causes.length === 0) {
    base.causes = ["no mechanical cause identified (open, unassigned, no unclosed blockers)"];
    base.known = false;
  }
  return base;
}

// Bead id -> cause-set already recorded on that bead this process. The
// detector runs every 60s; without this memo a long-lived daemon would stamp
// the identical classification onto the same bead every interval.
const recordedExclusionCauses = new Map<string, string>();

// Append the classification to the bead's notes. `bead update --notes`
// REPLACES the field rather than appending (verified against bead-rs
// 2026-09-08), so the existing notes are read from the same full-list snapshot
// that fed the classifier and rewritten with the classification appended.
// When existing notes cannot be read the write is skipped entirely — losing an
// operator's notes would be a worse mutation than missing one diagnostic line.
// Nothing else is ever mutated: no status, assignee, or dependency changes.
function recordExclusionNote(bead: BeadRecord, classification: ExcludedBeadClassification): void {
  const causeSet = classification.causes.join("; ");
  if (recordedExclusionCauses.get(bead.id) === causeSet) return;

  const existing = (bead.notes ?? "").trim();
  if (bead.notes === undefined || bead.notes === null) {
    console.error(`[starvation] skipping note on ${bead.id}: existing notes unreadable, refusing to replace`);
    return;
  }
  const line = `starvation classification (${new Date().toISOString()}): ${causeSet}`;
  const merged = existing ? `${existing}\n\n${line}` : line;

  try {
    // argv array, not a shell string: notes are free-form text and must never
    // be reinterpreted by a shell (same rule as the alert bead below).
    execFileSync(BEAD_BIN, ["update", bead.id, "--notes", merged], {
      encoding: "utf-8",
      timeout: 30000,
    });
    recordedExclusionCauses.set(bead.id, causeSet);
  } catch (err) {
    console.error(`[starvation] failed to record classification on ${bead.id}:`, err);
  }
}

// Detect bead starvation: open beads that aren't visible to pluck (ready frontier)
export async function detectBeadStarvation(): Promise<StarvationDiagnostic | null> {
  try {
    // Bead store is in workspace root, not daemon directory
    const workspace = process.env.PWD || process.cwd();
    const workspaceRoot = workspace.endsWith("/daemon") ? workspace.slice(0, -7) : workspace;
    const timestamp = new Date().toISOString();

    // Get open bead count (parse JSONL format - newline-delimited JSON objects)
    // Suppress stderr to avoid diagnostic output breaking JSON parsing
    const openResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --status open --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    // Parse JSONL format: split by newlines and parse each line as a JSON object
    const openBeads: BeadRecord[] = openResult.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

    // Get ready (pluck-visible) bead count (parse JSONL format)
    const readyResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --ready --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    // Parse JSONL format: split by newlines and parse each line as a JSON object
    const readyBeads: BeadRecord[] = readyResult.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

    // Diff the ID sets rather than subtracting counts: the two CLI calls are
    // separate snapshots of a live store, and a bead claimed or closed between
    // them would otherwise make ready_beads + excluded_beads != open_beads —
    // which validateStarvationAlert rejects and would misfile as a detector bug.
    const readyIds = new Set(readyBeads.map(bead => bead.id));
    const excludedBeads = openBeads.filter(bead => !readyIds.has(bead.id));

    const openCount = openBeads.length;
    const readyCount = openCount - excludedBeads.length;
    const excludedCount = excludedBeads.length;

    // No starvation if there are no open beads, or if all open beads are ready
    if (openCount === 0 || excludedCount === 0) {
      return null;
    }

    console.log(`[starvation] detected: ${openCount} open beads, ${readyCount} ready beads, ${excludedCount} excluded`);

    // Classify each excluded bead mechanically (trailbos-ba86503f) instead of
    // leaving exclusion_reasons to guess at. The full list supplies blocker
    // statuses and the notes each classification must append to — one call
    // covers both, and its failures degrade to classification without notes.
    const statusById = new Map<string, string>();
    const notesById = new Map<string, string>();
    try {
      const allResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      for (const bead of parseJsonl<BeadRecord>(allResult)) {
        statusById.set(bead.id, bead.status ?? "unknown");
        notesById.set(bead.id, bead.notes ?? "");
      }
    } catch (err) {
      console.error("[starvation] full bead list unavailable; blocker statuses will read unknown:", err);
    }

    const heartbeatByWorker = loadLastHeartbeatByWorker(path.join(workspaceRoot, ".beads", "heartbeats.jsonl"));
    const claimerByBead = loadLastClaimerByBead(path.join(workspaceRoot, ".beads", "events.jsonl"));
    const nowMs = Date.now();

    const classifications = excludedBeads.map(bead => {
      // The full list is the fresher read: a bead claimed between the open and
      // ready snapshots classifies by its real status, not the stale one.
      const freshStatus = statusById.get(bead.id);
      const beadForClassification: BeadRecord = freshStatus !== undefined ? { ...bead, status: freshStatus } : bead;
      return classifyExcludedBead(
        beadForClassification,
        statusById,
        heartbeatByWorker,
        claimerByBead,
        nowMs
      );
    });

    for (const classification of classifications) {
      if (!classification.known) continue; // unknown causes belong on the alert, not on the bead
      const bead = excludedBeads.find(b => b.id === classification.bead_id)!;
      const notes = notesById.get(bead.id);
      recordExclusionNote({ ...bead, notes }, classification);
    }

    const exclusionReasons = classifications.map(c => `bead ${c.bead_id}: ${c.causes.join("; ")}`);

    const diagnostic: StarvationDiagnostic = {
      timestamp,
      workspace: workspaceRoot,
      open_beads: openCount,
      ready_beads: readyCount,
      excluded_beads: excludedCount,
      exclusion_reasons: exclusionReasons,
      recovered: false,
      recovery_attempts: [],
    };

    // Attempt recovery
    diagnostic.recovery_attempts.push("attempting bead sync flush");
    try {
      execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} sync flush-only`, {
        encoding: "utf-8",
        timeout: 30000,
      });
      diagnostic.recovery_attempts.push("bead sync flush completed");

      // Re-check after recovery (parse JSONL format)
      const readyAfterResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --ready --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 10000,
      });
      // Parse JSONL format: split by newlines and parse each line as a JSON object
      const readyAfterCount = readyAfterResult.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line)).length;

      if (readyAfterCount === openCount) {
        diagnostic.recovered = true;
        diagnostic.recovery_attempts.push("starvation resolved after sync flush");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      diagnostic.error = error;
      diagnostic.recovery_attempts.push(`recovery failed: ${error}`);
    }

    // Log diagnostic payload
    logStarvationDiagnostic(diagnostic);

    // Create alert bead if recovery failed
    if (!diagnostic.recovered) {
      createStarvationAlertBead(diagnostic);
    }

    return diagnostic;
  } catch (err) {
    console.error("[starvation] detection error:", err);
    return null;
  }
}

// Log starvation diagnostic to .beads/diagnostics/<prefix>-*.jsonl
function logStarvationDiagnostic(diagnostic: StarvationDiagnostic, prefix: string = "starvation"): void {
  try {
    const diagnosticsDir = ".beads/diagnostics";
    execSync(`mkdir -p ${diagnosticsDir}`, { stdio: "ignore" });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${diagnosticsDir}/${prefix}-${timestamp}.jsonl`;

    // fs, not a `tee` shell-out: this box has no /bin/bash (NixOS), and the
    // payload would otherwise be reinterpreted by whatever shell did exist.
    fs.appendFileSync(logFile, JSON.stringify(diagnostic) + "\n");

    console.log(`[starvation] diagnostic logged to ${logFile}`);
  } catch (err) {
    console.error("[starvation] failed to log diagnostic:", err);
  }
}

// A diagnostic is only worth an alert if it actually asserts starvation: a
// known workspace, at least one open bead, and at least one bead excluded from
// the ready frontier, with counts that add up. The alert beads filed for
// trailbos-317b7ae2 were self-inconsistent — blank workspace, 0 open, 0
// excluded — which describes a detector bug, not starvation.
//
// Empty exclusion_reasons is deliberately NOT disqualifying: starvation whose
// cause the detector cannot name is exactly what `alert:starvation:unknown`
// covers.
export function validateStarvationAlert(diagnostic: StarvationDiagnostic): { actionable: boolean; reason?: string } {
  if (!diagnostic.workspace || diagnostic.workspace.trim() === "") {
    return { actionable: false, reason: "workspace is blank" };
  }
  if (!Number.isFinite(diagnostic.open_beads) || diagnostic.open_beads <= 0) {
    return { actionable: false, reason: `open_beads is ${diagnostic.open_beads}; starvation requires at least 1` };
  }
  if (!Number.isFinite(diagnostic.excluded_beads) || diagnostic.excluded_beads <= 0) {
    return { actionable: false, reason: `excluded_beads is ${diagnostic.excluded_beads}; starvation requires at least 1` };
  }
  if (!Number.isFinite(diagnostic.ready_beads) || diagnostic.ready_beads < 0) {
    return { actionable: false, reason: `ready_beads is ${diagnostic.ready_beads}; expected a non-negative count` };
  }
  if (diagnostic.ready_beads + diagnostic.excluded_beads !== diagnostic.open_beads) {
    return {
      actionable: false,
      reason: `counts disagree: ready (${diagnostic.ready_beads}) + excluded (${diagnostic.excluded_beads}) != open (${diagnostic.open_beads})`,
    };
  }
  return { actionable: true };
}

// One detector-bug bead per process: a broken detector would otherwise file a
// bug bead every detection interval on top of the diagnostics it logs.
let detectorBugBeadFiled = false;

// A diagnostic the detector could not act on means the detector emitted
// nonsense — a bug in the detector, not starvation in the workspace. File one
// bug bead so the emitter gets fixed, instead of an operator triaging a
// phantom starvation alert.
function fileDetectorBugBead(reason: string, diagnostic: StarvationDiagnostic): void {
  if (detectorBugBeadFiled) {
    console.log("[starvation] detector-bug bead already filed this process; diagnostic logged only");
    return;
  }

  const description = `The starvation detector produced a diagnostic it could not act on.

**Reason:** ${reason}

\`\`\`json
${JSON.stringify(diagnostic, null, 2)}
\`\`\`

The diagnostic was written to .beads/diagnostics/starvation-detector-bug-*.jsonl.
No starvation alert bead was created from it (guard added in trailbos-6d972074,
cross-linked to trailbos-317b7ae2).`;

  try {
    execFileSync(
      BEAD_BIN,
      [
        "create",
        "--title", "Starvation detector bug: non-actionable diagnostic reached the alert emitter",
        "--priority", "2",
        "--issue-type", "bug",
        "--label", "starvation-detector-bug",
        "--description", description,
      ],
      { encoding: "utf-8", timeout: 30000 }
    );
    detectorBugBeadFiled = true;
    console.log("[starvation] detector-bug bead created");
  } catch (err) {
    console.error("[starvation] failed to create detector-bug bead:", err);
  }
}

// Create a starvation alert bead. Self-inconsistent diagnostics are never
// alerted: they are routed to .beads/diagnostics/ and reported as a detector
// bug instead.
export function createStarvationAlertBead(diagnostic: StarvationDiagnostic): void {
  const validation = validateStarvationAlert(diagnostic);
  if (!validation.actionable) {
    console.error(`[starvation] suppressing non-actionable diagnostic: ${validation.reason}`);
    logStarvationDiagnostic(diagnostic, "starvation-detector-bug");
    fileDetectorBugBead(validation.reason ?? "unknown", diagnostic);
    return;
  }

  const description = `Pluck found no candidates but open beads exist.

**Workspace:** ${diagnostic.workspace}
**Open beads:** ${diagnostic.open_beads}
**Excluded beads:** ${diagnostic.excluded_beads}
**Exclusion reasons:** ${diagnostic.exclusion_reasons.join("; ") || "none detected"}

**Timestamp:** ${diagnostic.timestamp}

**Recovery attempts:**
${diagnostic.recovery_attempts.map(attempt => `- ${attempt}`).join("\n")}

${diagnostic.error ? `**Error:** ${diagnostic.error}` : ""}`;

  try {
    // argv array, not a shell string: the description carries free-form error
    // text that must never be reinterpreted by a shell. --description, not
    // --notes: `bead create` has no --notes flag, so the old command failed
    // silently inside this try/catch and no alert ever reached the queue.
    execFileSync(
      BEAD_BIN,
      [
        "create",
        "--title", `Starvation alert: beads invisible in ${diagnostic.workspace}`,
        "--priority", "2",
        "--issue-type", "task",
        "--label", "alert:starvation:unknown",
        "--label", "starvation-alert",
        "--description", description,
      ],
      { encoding: "utf-8", timeout: 30000 }
    );
    console.log("[starvation] alert bead created");
  } catch (err) {
    console.error("[starvation] failed to create alert bead:", err);
  }
}

// Start starvation detection loop (runs every 60 seconds)
export function startStarvationDetection(intervalMs: number = 60000): void {
  console.log(`[starvation] started detection loop (interval ${intervalMs}ms)`);
  setInterval(async () => {
    const diagnostic = await detectBeadStarvation();
    if (diagnostic) {
      console.log(`[starvation] detected ${diagnostic.excluded_beads} excluded beads (open: ${diagnostic.open_beads}, ready: ${diagnostic.ready_beads})`);
      if (diagnostic.recovered) {
        console.log(`[starvation] recovery successful`);
      } else {
        console.log(`[starvation] recovery failed; diagnostic dispatched (alert bead, or detector-bug bead if non-actionable)`);
      }
    }
  }, intervalMs);
}

// Check if a pane exists in tmux
function paneExists(paneId: string): boolean {
  try {
    const tmuxSocket = process.env.TMUX_TEST_SOCK || "";
    const tmuxCmd = tmuxSocket ? `tmux -S ${tmuxSocket}` : "tmux";
    const result = execSync(`${tmuxCmd} list-panes -F '#{pane_id}' -t "${paneId}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.toString().trim().includes(paneId);
  } catch {
    return false;
  }
}

// Read the last entry from a transcript to detect stuck state
// Returns { isStuck: boolean, lastAssistantTime: number | null, lastMessage: string | null }
export function detectStuckFromTranscriptTail(
  transcriptPath: string
): { isStuck: boolean; lastAssistantTime: number | null; lastMessage: string | null } {
  if (!fs.existsSync(transcriptPath)) {
    return { isStuck: false, lastAssistantTime: null, lastMessage: null };
  }

  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");
    if (lines.length === 0) {
      return { isStuck: false, lastAssistantTime: null, lastMessage: null };
    }

    // Check the last 5 entries to find the last assistant turn and see if there's a user message after it
    let lastAssistantTime: number | null = null;
    let lastMessage: string | null = null;
    let foundUserAfterLastAssistant = false;

    // First pass: find the last assistant turn and its message
    const checkCount = Math.min(5, lines.length);
    for (let i = lines.length - checkCount; i < lines.length; i++) {
      try {
        const entry: TranscriptEntry = JSON.parse(lines[i]);
        const entryTime = parseTimestamp(entry.timestamp);

        if (entry.type === "assistant" || entry.message?.role === "assistant") {
          // Found an assistant turn - track it as potentially the stuck point
          lastAssistantTime = entryTime;
          // Try to extract a message from the assistant content
          const content = entry.message?.content;
          if (typeof content === "string") {
            lastMessage = content.length > 100 ? content.slice(0, 97) + "..." : content;
          } else if (content && typeof content === "object" && "text" in content) {
            const text = String((content as { text: string }).text);
            lastMessage = text.length > 100 ? text.slice(0, 97) + "..." : text;
          }
        }
      } catch {
        continue; // Skip malformed lines
      }
    }

    // Second pass: check if there's a user message after the last assistant turn
    if (lastAssistantTime !== null) {
      for (let i = lines.length - checkCount; i < lines.length; i++) {
        try {
          const entry: TranscriptEntry = JSON.parse(lines[i]);
          const entryTime = parseTimestamp(entry.timestamp);

          if ((entry.type === "user" || entry.message?.role === "user") && entryTime > lastAssistantTime) {
            foundUserAfterLastAssistant = true;
            break;
          }
        } catch {
          continue; // Skip malformed lines
        }
      }
    }

    // Session is stuck if the last assistant turn has no following user message
    const isStuck = lastAssistantTime !== null && !foundUserAfterLastAssistant;
    return { isStuck, lastAssistantTime, lastMessage };
  } catch {
    return { isStuck: false, lastAssistantTime: null, lastMessage: null };
  }
}

// Stuck-direction reconcile: find sessions that became stuck while daemon was down
// and enqueue them
export function reconcileStuckDirection(): { enqueued: number; checked: number } {
  const sessions = getSessionsNotInQueue(100);
  let enqueued = 0;

  for (const sess of sessions) {
    // Skip if pane no longer exists
    if (!paneExists(sess.pane_id)) {
      continue;
    }

    // Check if transcript tail shows session is stuck
    const { isStuck, lastAssistantTime } = detectStuckFromTranscriptTail(sess.transcript_path);

    if (isStuck && lastAssistantTime !== null) {
      // Enqueue with reason=stopped and stuck_at derived from assistant timestamp
      enqueue(sess.session_id, "stopped", lastAssistantTime);

      // Update session record with stuck info
      upsertSession(
        sess.session_id,
        sess.pane_id,
        sess.cwd,
        sess.transcript_path,
        lastAssistantTime,
        "stopped",
        null // message already derived from transcript
      );

      enqueued++;
      console.log(`[reconcile] stuck-direction enqueued ${sess.session_id.slice(0, 8)} (reason=stopped)`);
    }
  }

  return { enqueued, checked: sessions.length };
}
