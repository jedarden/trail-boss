// Transcript reconcile loop: the transcript JSONL is ground truth
import * as fs from "fs";
import * as path from "path";
import { execFileSync, execSync } from "child_process";
import { getSession, dequeue, getSessionsForReconcile, upsertSession, enqueue, getSessionsNotInQueue, BEAD_LIST_LIMIT } from "./db.ts";

// Full path because the systemd service has no ~/.local/bin in PATH.
// Overridable so tests can point this at a stub CLI (TRAILBOSS_BEAD_BIN).
const BEAD_BIN = process.env.TRAILBOSS_BEAD_BIN || "/home/coding/.local/bin/bead";

// A worker with no runtime signal newer than this is considered verifiably
// dead, and beads assigned to it are safe to clear (trailbos-4cca2e94).
// Overridable so tests can exercise both sides of the window.
const HEARTBEAT_STALE_MS = parseStaleWindowMs(process.env.TRAILBOSS_HEARTBEAT_STALE_MS, 30 * 60 * 1000);

// Minimum interval between in-place refreshes of one alert bead. The detector
// runs every 60s; without this throttle a persistent starvation would append
// a near-identical block to the alert's notes every cycle, without bound.
// Overridable so tests can force a refresh on demand.
const ALERT_REFRESH_MIN_MS = parseStaleWindowMs(process.env.TRAILBOSS_ALERT_REFRESH_MIN_MS, 10 * 60 * 1000);

// Refresh blocks kept in an alert bead's notes. Each refresh replaces notes
// wholesale (read-modify-write), so the history is pruned here: the bead's
// original text survives, older machine-written blocks fall off.
const ALERT_REFRESH_HISTORY = 5;

// Line that begins a refresh block inside an alert bead's notes, with the ISO
// timestamp of the refresh as the rest of the line.
const ALERT_REFRESH_MARKER = "starvation alert refresh @ ";

// Label the alert path stamps on every starvation alert bead. The lifecycle
// finds the alerts it owns by listing open beads carrying it.
const STARVATION_ALERT_LABEL = "starvation-alert";

// The labels the harness holds out of claim by design. Three are pluck's own
// exclude_labels (deferred, human, blocked — ~/.needle/config.yaml, and the
// harness's starvation events record exclusions as `label:<name>`); the other
// two are its split vocabulary: `mitosis-parent` is the umbrella a parent
// carries while only its children are meant to be claimed, and `split-child`
// marks a bead rescoped into a split (NEEDLE src/strand/analyze.rs
// SPLIT_CHILD_LABEL). A bead carrying one is invisible to workers on purpose,
// so its absence from the frontier is not starvation — the tb-bctb false
// positive was exactly this shape, every excluded bead label-filtered.
//
// Note that `bead list --ready` does NOT apply these: the exclude_labels live
// in pluck's config, not in the bead store, so a held bead sits in the
// bead-rs frontier too. Any detector that derives exclusions from the
// open-vs-ready diff alone reads excluded=0 in exactly the cycles pluck is
// holding beads out (trailbos-383d1150).
const HOLD_BY_DESIGN_LABELS = new Set([
  "deferred",
  "human",
  "blocked",
  "mitosis-parent",
  "split-child",
]);

// Label prefix pluck quarantines a repeatedly-failing bead with: unclaimable
// until the timestamp, claimable again once it passes — quarantine fails open
// (the operator's 290e138 deferral landed precisely because these stamps had
// already passed and the beads were being reselected). Nanosecond precision;
// parseTimestamp tolerates it.
const QUARANTINE_LABEL_PREFIX = "quarantine-until:";

function parseStaleWindowMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

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
  // Per-bead classification behind exclusion_reasons, so the alert lifecycle
  // can tell a deliberate exclusion from an unexplained one without
  // re-deriving it. Optional because hand-built diagnostics (tests, incident
  // replays) predate it.
  excluded_classifications?: ExcludedBeadClassification[];
  recovered: boolean;
  recovery_attempts: string[];
  error?: string;
}

// One bead as returned by `bead list --json` (JSONL, one object per line).
// Only the fields the exclusion classifier and the alert lifecycle read are
// declared; the CLI emits more.
interface BeadRecord {
  id: string;
  title: string;
  status: string;
  assignee?: string | null;
  manual_blocked?: boolean;
  dependencies?: Array<{ blocker: string; kind: string }>;
  notes?: string | null;
  labels?: string[];
  revision?: number;
  created_at?: string;
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
// exists for. `deliberate` is the stronger, benign flag: every cause is a
// hold-back the harness or an operator chose (pluck label filter, manual
// block), so the bead's absence from the frontier is not starvation at all.
export interface ExcludedBeadClassification {
  bead_id: string;
  title: string;
  status: string;
  assignee: string | null;
  causes: string[];
  known: boolean;
  deliberate: boolean;
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

// Worker -> most recent event of any kind (claim, dispatch, result). Liveness
// signal #2 for the assignee clearing below: most of this fleet writes events
// but never heartbeats, so a heartbeat-only check would read live workers as
// dead.
export function loadLastEventByWorker(filePath: string): Map<string, BeadEventEntry> {
  const byWorker = new Map<string, BeadEventEntry>();
  if (!fs.existsSync(filePath)) return byWorker;
  try {
    for (const entry of parseJsonl<BeadEventEntry>(fs.readFileSync(filePath, "utf-8"))) {
      if (entry?.worker) byWorker.set(entry.worker, entry);
    }
  } catch (err) {
    console.error("[starvation] failed to read bead events:", err);
  }
  return byWorker;
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

// The ids of `bead`'s `blocks` dependencies — the edges that can hold it out
// of the frontier. Shared by unclosedBlockers and the hold-expiry check, which
// need the same edge set.
function blockerRefs(bead: BeadRecord): string[] {
  const out: string[] = [];
  for (const dep of bead.dependencies ?? []) {
    if (dep.kind && dep.kind !== "blocks") continue;
    out.push(dep.blocker);
  }
  return out;
}

// The `blocks` dependencies of `bead` whose blocker is not finished, with each
// blocker's status. Shared by the classifier (which names them as causes) and
// the dead-worker remediation (which needs "assignee is the ONLY exclusion").
function unclosedBlockers(bead: BeadRecord, statusById: Map<string, string>): Array<{ id: string; status: string }> {
  const out: Array<{ id: string; status: string }> = [];
  for (const id of blockerRefs(bead)) {
    const status = statusById.get(id)?.toLowerCase() ?? "unknown";
    if (!FINISHED_STATUSES.has(status)) out.push({ id, status });
  }
  return out;
}

// Why a hold-by-design label no longer justifies the bead's invisibility, or
// null while the hold stands. Two mechanical expiry forms: a
// `quarantine-until:<ts>` label whose stamp has passed (pluck's quarantine
// fails open — once the stamp is past, the hold label is the only thing
// keeping the bead out, so the stamp is the evidence the hold is stale), and
// a `deferred`/`blocked` hold whose every referenced blocker has since closed:
// the wait the hold asserted is over. `human`/`mitosis-parent`/`split-child`
// hold by ownership and structure, not by waiting on anything, so only the
// waiting labels expire through their blockers. An unparseable quarantine
// stamp never reads as expired — an unreadable stamp must fail toward "the
// hold stands", never toward alerting.
function expiredHoldReason(
  bead: BeadRecord,
  statusById: Map<string, string>,
  nowMs: number
): string | null {
  for (const label of bead.labels ?? []) {
    if (!label.startsWith(QUARANTINE_LABEL_PREFIX)) continue;
    const raw = label.slice(QUARANTINE_LABEL_PREFIX.length);
    const until = parseTimestamp(raw);
    if (until > 0 && until <= nowMs) {
      return `${QUARANTINE_LABEL_PREFIX}${raw} passed ${formatAge(nowMs - until)} ago`;
    }
  }

  const waiting = (bead.labels ?? []).filter(label => label === "deferred" || label === "blocked");
  const refs = blockerRefs(bead);
  if (waiting.length > 0 && refs.length > 0 && unclosedBlockers(bead, statusById).length === 0) {
    const closed = refs.map(id => `${id} (${statusById.get(id)?.toLowerCase() ?? "unknown"})`).join(", ");
    return `every referenced blocker has finished (${closed}) — the '${waiting.join("', '")}' hold waits on nothing`;
  }
  return null;
}

// Classify one excluded bead's invisibility cause from bead data alone — no
// human judgment, every cause read from fields that already exist.
// Precedence: manual_blocked and the pluck exclude labels are deliberate
// hold-backs and end the classification (a label hold only while its
// rationale — quarantine stamp, waiting set — is still live); an in_progress
// bead reports its worker's heartbeat; an open bead reports a dead-assignee
// candidate and/or its unclosed blockers.
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
    deliberate: false,
  };

  // (d) manual_blocked: the flag is deliberate — record it and skip the dig.
  if (bead.manual_blocked) {
    base.causes = ["manually blocked (deliberate flag; not classified further)"];
    base.deliberate = true;
    return base;
  }

  // (e) pluck exclude labels: the harness holds these out of the frontier by
  // design, so the exclusion is chosen, not broken. This is the tb-bctb
  // "all beads label-filtered" shape — including the alert beads themselves,
  // which carry `human` and were then counted as starved by their own alert.
  // The hold only stays deliberate while its rationale does: an expired
  // quarantine stamp or a fully-closed blocker set classifies as a stale hold
  // (deliberate=false), so the alert names it as evidence instead of waving
  // the bead through as chosen (trailbos-383d1150).
  const labelFiltered = (bead.labels ?? []).filter(label => HOLD_BY_DESIGN_LABELS.has(label));
  if (labelFiltered.length > 0) {
    const expiry = expiredHoldReason(bead, statusById, nowMs);
    if (expiry !== null) {
      base.causes = [
        `hold expired: ${expiry}; label filter (${labelFiltered.map(label => `'${label}'`).join(", ")}) ` +
        `still applied but no longer explains the invisibility`,
      ];
      base.deliberate = false;
      return base;
    }
    base.causes = [
      `excluded by label filter (${labelFiltered.map(label => `'${label}'`).join(", ")}) — deliberate, not starvation`,
    ];
    base.deliberate = true;
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
  for (const blocker of unclosedBlockers(bead, statusById)) {
    base.causes.push(`blocked by ${blocker.id} (${blocker.status})`);
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

// Newest runtime signal (heartbeat or event) for one worker short name, or
// null when that worker appears in neither runtime log.
function workerLastSeenMs(
  worker: string,
  heartbeatByWorker: Map<string, HeartbeatEntry>,
  lastEventByWorker: Map<string, BeadEventEntry>
): number | null {
  let newest: number | null = null;
  const heartbeat = heartbeatByWorker.get(worker);
  if (heartbeat?.ts) {
    const ts = parseTimestamp(heartbeat.ts);
    if (ts > 0 && (newest === null || ts > newest)) newest = ts;
  }
  const event = lastEventByWorker.get(worker);
  if (event?.ts) {
    const ts = parseTimestamp(event.ts);
    if (ts > 0 && (newest === null || ts > newest)) newest = ts;
  }
  return newest;
}

// Newest runtime signal across every worker name a bead's assignment maps to,
// or null when none of them has any recorded signal. Assignees are Claude
// session names (`claude-code-glm-5.3-flash-glm-acb`) while the runtime logs
// name fleet workers (`glm-acb`), so besides a direct hit on the assignee
// itself, the bead's claim event names the worker that took it — the same
// bridge classifyExcludedBead uses.
export function resolveBeadWorkerLastSeen(
  bead: BeadRecord,
  claimerByBead: Map<string, BeadEventEntry>,
  heartbeatByWorker: Map<string, HeartbeatEntry>,
  lastEventByWorker: Map<string, BeadEventEntry>
): number | null {
  const assignee = bead.assignee && bead.assignee !== "null" ? bead.assignee : null;
  if (!assignee) return null;

  let newest: number | null = null;
  const candidates = new Set<string>([assignee]);
  const claimedBy = claimerByBead.get(bead.id)?.worker;
  if (claimedBy) candidates.add(claimedBy);
  for (const worker of candidates) {
    const seen = workerLastSeenMs(worker, heartbeatByWorker, lastEventByWorker);
    if (seen !== null && (newest === null || seen > newest)) newest = seen;
  }
  return newest;
}

// Second mechanical remediation for assigned-but-open starvation
// (trailbos-4cca2e94): `bead update --clear-assignee`, the documented fix —
// `bead release` deliberately refuses this state ("use update --clear-assignee
// instead"), and the 2026-08-16 fleet sweep found 583 beads starved in it.
//
// An assignee is cleared only when its worker is VERIFIABLY dead: it has a
// runtime trail (heartbeat or event) and the newest entry is older than
// HEARTBEAT_STALE_MS. A worker with no trail at all cannot be verified dead —
// most of this fleet writes events but no heartbeats — so those beads are left
// for the alert path rather than cleared on an absence of evidence. Likewise a
// bead that is in_progress or manually blocked is never a candidate, and
// neither is one whose exclusion has any other cause (an unclosed blocker):
// clearing those would not put them on the ready frontier anyway.
//
// Returns the number of assignees cleared; every decision lands in
// diagnostic.recovery_attempts so the alert (when one is still filed) carries
// the triage.
export function clearAssigneesOfDeadWorkers(
  diagnostic: StarvationDiagnostic,
  workspaceRoot: string,
  excludedBeads: BeadRecord[],
  statusById: Map<string, string>,
  claimerByBead: Map<string, BeadEventEntry>,
  heartbeatByWorker: Map<string, HeartbeatEntry>,
  lastEventByWorker: Map<string, BeadEventEntry>,
  nowMs: number = Date.now()
): number {
  const candidates = excludedBeads.filter(bead => {
    const assignee = bead.assignee && bead.assignee !== "null" ? bead.assignee : null;
    if (!assignee) return false;
    // Never clear an in_progress or manually blocked bead, whatever its assignee.
    const status = (statusById.get(bead.id) ?? bead.status ?? "").toLowerCase();
    if (status === "in_progress" || bead.manual_blocked) return false;
    // The assignee must be the bead's ONLY exclusion: no unclosed blocker too.
    return unclosedBlockers(bead, statusById).length === 0;
  });
  if (candidates.length === 0) {
    diagnostic.recovery_attempts.push("no excluded bead is held back by its assignee alone");
    return 0;
  }

  let cleared = 0;
  for (const bead of candidates) {
    const assignee = bead.assignee!;
    const lastSeen = resolveBeadWorkerLastSeen(bead, claimerByBead, heartbeatByWorker, lastEventByWorker);
    if (lastSeen !== null && nowMs - lastSeen < HEARTBEAT_STALE_MS) {
      diagnostic.recovery_attempts.push(
        `bead ${bead.id}: worker ${assignee} signal live (${formatAge(nowMs - lastSeen)} old); assignee kept`
      );
      continue;
    }
    if (lastSeen === null) {
      diagnostic.recovery_attempts.push(
        `bead ${bead.id}: assignee ${assignee} has no heartbeat or event trail; cannot verify the worker is dead; assignee kept`
      );
      continue;
    }

    try {
      // argv array, not a shell string: ids come from bead JSON and must never
      // be reinterpreted by a shell (same rule as the alert bead below).
      execFileSync(BEAD_BIN, ["update", bead.id, "--clear-assignee"], {
        encoding: "utf-8",
        timeout: 30000,
        cwd: workspaceRoot,
      });
      cleared++;
      diagnostic.recovery_attempts.push(
        `bead ${bead.id}: cleared assignee ${assignee} — worker silent for ${formatAge(nowMs - lastSeen)}`
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      diagnostic.recovery_attempts.push(`bead ${bead.id}: failed to clear assignee ${assignee}: ${error}`);
    }
  }
  return cleared;
}

// Count the ready frontier. Each call is a separate snapshot of a live store,
// so callers compare it only against counts taken for the same decision.
function countReadyBeads(workspaceRoot: string): number {
  const result = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --ready --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
    encoding: "utf-8",
    timeout: 10000,
  });
  // JSONL format: one bead object per non-empty line
  return result.trim().split("\n").filter(line => line.trim()).length;
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
    const lastEventByWorker = loadLastEventByWorker(path.join(workspaceRoot, ".beads", "events.jsonl"));
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
      excluded_classifications: classifications,
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

      // Re-check after recovery
      if (countReadyBeads(workspaceRoot) === openCount) {
        diagnostic.recovered = true;
        diagnostic.recovery_attempts.push("starvation resolved after sync flush");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      diagnostic.error = error;
      diagnostic.recovery_attempts.push(`recovery failed: ${error}`);
    }

    // Second remediation (trailbos-4cca2e94): the flush only fixes checkpoint
    // lag. Assigned-but-open starvation has a different fix — clear the
    // assignee — but only when the worker behind it is verifiably dead.
    if (!diagnostic.recovered) {
      const cleared = clearAssigneesOfDeadWorkers(
        diagnostic,
        workspaceRoot,
        excludedBeads,
        statusById,
        claimerByBead,
        heartbeatByWorker,
        lastEventByWorker,
        nowMs
      );
      if (cleared > 0) {
        try {
          const readyAfterClear = countReadyBeads(workspaceRoot);
          if (readyAfterClear > readyCount) {
            diagnostic.recovered = true;
            diagnostic.recovery_attempts.push(
              `starvation resolved after clearing dead-worker assignees (ready ${readyCount} -> ${readyAfterClear})`
            );
          } else {
            diagnostic.recovery_attempts.push(
              `ready frontier unchanged after clearing dead-worker assignees (${readyAfterClear})`
            );
          }
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          diagnostic.recovery_attempts.push(`ready frontier re-check failed: ${error}`);
        }
      }
    }

    // Log diagnostic payload
    logStarvationDiagnostic(diagnostic);

    // Alert beads are not filed here: the alert lifecycle owns them
    // (reconcileStarvationAlerts), so a persistent starvation refreshes one
    // bead instead of filing a duplicate every cycle, and a resolved one is
    // closed instead of left to rot.
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

// Create a starvation alert bead. Called only from the alert lifecycle, which
// has already established that no starvation alert is open — that is the
// dedup: a persistent starvation refreshes its one alert instead of re-filing
// one per 60s cycle (the old behavior stacked up 263 beads in this
// workspace). Self-inconsistent diagnostics are never alerted: they are
// routed to .beads/diagnostics/ and reported as a detector bug instead.
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

// ---------------------------------------------------------------------------
// Alert lifecycle (trailbos-60a684b9): the loop that detects starvation also
// resolves its own alerts. Every 60s cycle the live state is compared against
// the open starvation-alert beads; each one is closed with evidence when the
// live state disproves it, refreshed in place when starvation genuinely
// persists, and a new alert is filed only when none is open. Invariant: at
// most one open starvation-alert bead per workspace at any time.
// ---------------------------------------------------------------------------

// What the lifecycle should do with the open alert beads this cycle.
// `close` carries the evidence quoted verbatim into the close reason.
type StarvationAlertCloseKind = "resolved" | "invalid" | "benign" | "duplicate";
export type StarvationAlertAction =
  | { action: "close"; kind: StarvationAlertCloseKind; evidence: string }
  | { action: "refresh" }
  | { action: "none"; reason: string };

// Fresh open/ready/excluded counts, used for close evidence and to tell "no
// starvation" apart from "detection failed". Returns null when the bead CLI
// cannot be consulted — an absent reading never closes anything.
function readFrontierCounts(workspaceRoot: string): { open: number; ready: number; excluded: number } | null {
  try {
    const openResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --status open --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    const open = openResult.trim().split("\n").filter(line => line.trim()).length;
    const ready = countReadyBeads(workspaceRoot);
    return { open, ready, excluded: Math.max(0, open - ready) };
  } catch (err) {
    console.error("[starvation] failed to read frontier counts:", err);
    return null;
  }
}

// Decide what the lifecycle must do with the open starvation-alert beads, from
// the live diagnostic alone. Close (false positive) when the live state
// disproves the alert; refresh when starvation genuinely persists; take no
// action when the evidence is not there to decide either way.
export async function decideStarvationAlertAction(
  diagnostic: StarvationDiagnostic | null,
  workspaceRoot: string
): Promise<StarvationAlertAction> {
  if (diagnostic === null) {
    // detectBeadStarvation() returns null both when the workspace genuinely
    // has no starvation and when detection itself failed. Only a fresh
    // frontier read distinguishes the two — an alert is never closed on a
    // detector error.
    const counts = readFrontierCounts(workspaceRoot);
    if (!counts) {
      return { action: "none", reason: "frontier counts unavailable; leaving open alerts as they stand" };
    }
    if (counts.open === 0 || counts.excluded === 0) {
      return {
        action: "close",
        kind: "resolved",
        evidence: `no starvation on a fresh read: ${counts.open} open beads, ${counts.ready} ready, ${counts.excluded} excluded (nothing held outside the ready frontier)`,
      };
    }
    return {
      action: "none",
      reason: `diagnostic was null but a fresh read still shows ${counts.excluded} excluded beads; taking no alert action this cycle`,
    };
  }

  if (diagnostic.recovered) {
    return {
      action: "close",
      kind: "resolved",
      evidence:
        `starvation recovered: ${diagnostic.open_beads} open beads, ${diagnostic.ready_beads} ready, ` +
        `${diagnostic.excluded_beads} excluded. Recovery: ${diagnostic.recovery_attempts.join("; ") || "none recorded"}`,
    };
  }

  const validation = validateStarvationAlert(diagnostic);
  if (!validation.actionable) {
    return {
      action: "close",
      kind: "invalid",
      evidence:
        `the diagnostic behind this alert is not actionable: ${validation.reason} ` +
        `(counts open=${diagnostic.open_beads} ready=${diagnostic.ready_beads} ` +
        `excluded=${diagnostic.excluded_beads}, workspace '${diagnostic.workspace}') — ` +
        `the trailbos-8cae488d blank-workspace/zero-field shape`,
    };
  }

  // Deliberate-exclusion shape: workers still have claimable work (frontier
  // non-empty) and every excluded bead is held back on purpose (pluck label
  // filter or manual block). Nothing is silently stuck — the tb-bctb
  // "all beads label-filtered" false positive.
  const classifications = diagnostic.excluded_classifications ?? [];
  if (
    diagnostic.ready_beads > 0 &&
    classifications.length > 0 &&
    classifications.every(c => c.deliberate)
  ) {
    const causes = classifications.map(c => `bead ${c.bead_id}: ${c.causes.join("; ")}`).join("; ");
    return {
      action: "close",
      kind: "benign",
      evidence:
        `ready frontier non-empty (${diagnostic.ready_beads} of ${diagnostic.open_beads} open beads ` +
        `visible to pluck) and every excluded bead is held back deliberately: ${causes}`,
    };
  }

  return { action: "refresh" };
}

// Open beads carrying the starvation-alert label, oldest first — the oldest is
// the canonical alert when more than one is open (the pre-lifecycle detector
// filed a fresh bead on every failed recovery). Returns null when the bead CLI
// cannot be consulted, so a listing failure never reads as "no alerts open"
// and files a duplicate.
export function listOpenStarvationAlerts(workspaceRoot: string): BeadRecord[] | null {
  try {
    const result = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --status open --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return parseJsonl<BeadRecord>(result)
      .filter(bead => Array.isArray(bead.labels) && bead.labels.includes(STARVATION_ALERT_LABEL))
      .sort((a, b) => parseTimestamp(a.created_at) - parseTimestamp(b.created_at));
  } catch (err) {
    console.error("[starvation] failed to list open starvation alerts:", err);
    return null;
  }
}

// Timestamp of the newest refresh block already in an alert bead's notes, or 0
// when it has never been refreshed.
function lastRefreshAtMs(notes: string): number {
  let newest = 0;
  for (const line of notes.split("\n")) {
    if (!line.startsWith(ALERT_REFRESH_MARKER)) continue;
    const ts = parseTimestamp(line.slice(ALERT_REFRESH_MARKER.length).trim());
    if (ts > newest) newest = ts;
  }
  return newest;
}

// Existing notes rewritten to make room for a new refresh block: the text
// before the first block is preserved untouched (operator content), and only
// the newest few machine-written blocks are kept.
function mergeRefreshNotes(existing: string, block: string): string {
  const lines = existing.split("\n");
  const markerIdx: number[] = [];
  lines.forEach((line, i) => {
    if (line.startsWith(ALERT_REFRESH_MARKER)) markerIdx.push(i);
  });

  const prelude = markerIdx.length === 0
    ? existing.trimEnd()
    : lines.slice(0, markerIdx[0]).join("\n").trimEnd();
  const keptFrom = markerIdx[Math.max(0, markerIdx.length - (ALERT_REFRESH_HISTORY - 1))];
  const kept = markerIdx.length === 0 ? "" : lines.slice(keptFrom).join("\n").trimEnd();

  return [prelude, kept, block.trimEnd()].filter(part => part !== "").join("\n\n");
}

// Close one alert bead, quoting the evidence into the required close reason.
// Failure is logged, never thrown: a close that cannot land retries on the
// next cycle against the still-open bead.
function closeStarvationAlert(
  alert: BeadRecord,
  action: { kind: StarvationAlertCloseKind; evidence: string },
  workspaceRoot: string
): void {
  const reason = `Auto-closed by the starvation alert lifecycle (${action.kind}). ${action.evidence}`;
  try {
    // argv array, not a shell string: the evidence carries free-form cause
    // text that must never be reinterpreted by a shell.
    execFileSync(BEAD_BIN, ["close", alert.id, "--reason", reason], {
      encoding: "utf-8",
      timeout: 30000,
      cwd: workspaceRoot,
    });
    console.log(`[starvation] closed alert bead ${alert.id} (${action.kind})`);
  } catch (err) {
    console.error(`[starvation] failed to close alert bead ${alert.id}:`, err);
  }
}

// Refresh one alert bead in place instead of filing a duplicate: fresh counts,
// timestamp, recovery attempts, and exclusion reasons, appended after the
// existing notes (read-modify-write — `bead update --notes` REPLACES), guarded
// by --if-revision so a concurrent edit is never clobbered. Throttled so a
// persistent starvation appends a block every ALERT_REFRESH_MIN_MS, not every
// 60s cycle.
function refreshStarvationAlert(
  alert: BeadRecord,
  diagnostic: StarvationDiagnostic,
  workspaceRoot: string
): void {
  const existing = alert.notes;
  if (existing === undefined || existing === null) {
    // Same refusal rule as recordExclusionNote: notes the snapshot could not
    // read must never be replaced — losing an operator's text is a worse
    // mutation than missing one refresh.
    console.error(`[starvation] skipping refresh of ${alert.id}: existing notes unreadable, refusing to replace`);
    return;
  }
  if (typeof alert.revision !== "number") {
    console.error(`[starvation] skipping refresh of ${alert.id}: revision unknown, refusing an unguarded write`);
    return;
  }

  const nowMs = Date.now();
  const newestWrite = Math.max(parseTimestamp(alert.created_at ?? ""), lastRefreshAtMs(existing));
  if (newestWrite > 0 && nowMs - newestWrite < ALERT_REFRESH_MIN_MS) {
    console.log(`[starvation] alert ${alert.id} written ${formatAge(nowMs - newestWrite)} ago; refresh throttled`);
    return;
  }

  const block = [
    ALERT_REFRESH_MARKER + new Date(nowMs).toISOString(),
    `still starved: open=${diagnostic.open_beads} ready=${diagnostic.ready_beads} excluded=${diagnostic.excluded_beads}`,
    ...diagnostic.exclusion_reasons.map(reason => `- ${reason}`),
    ...diagnostic.recovery_attempts.map(attempt => `- ${attempt}`),
  ].join("\n");

  try {
    execFileSync(
      BEAD_BIN,
      ["update", alert.id, "--notes", mergeRefreshNotes(existing.trimEnd(), block), "--if-revision", String(alert.revision)],
      { encoding: "utf-8", timeout: 30000, cwd: workspaceRoot }
    );
    console.log(`[starvation] refreshed alert bead ${alert.id} in place (revision ${alert.revision})`);
  } catch (err) {
    // A revision conflict means someone edited the bead mid-cycle; skipping
    // loses nothing — the next cycle re-reads and retries with fresh numbers.
    console.error(`[starvation] failed to refresh alert bead ${alert.id} (revision moved?):`, err);
  }
}

// Reconcile the open starvation-alert beads against the live diagnostic.
// Wired into the 60s startStarvationDetection loop right after
// detectBeadStarvation(), whose result this consumes.
export async function reconcileStarvationAlerts(diagnostic: StarvationDiagnostic | null): Promise<void> {
  const workspace = process.env.PWD || process.cwd();
  const workspaceRoot = workspace.endsWith("/daemon") ? workspace.slice(0, -7) : workspace;

  const alerts = listOpenStarvationAlerts(workspaceRoot);
  if (alerts === null) {
    console.error("[starvation] alert lifecycle skipped: open alerts could not be listed");
    return;
  }

  const action = await decideStarvationAlertAction(diagnostic, workspaceRoot);
  if (action.action === "none") {
    console.log(`[starvation] alert lifecycle: no action (${action.reason})`);
    return;
  }

  if (alerts.length === 0) {
    if (action.action === "close") return; // nothing open to close
    // refresh verdict + no open alert => this cycle files the first alert
    createStarvationAlertBead(diagnostic!);
    return;
  }

  if (action.action === "close") {
    for (const alert of alerts) closeStarvationAlert(alert, action, workspaceRoot);
    return;
  }

  // Starvation persists: keep the oldest alert as the single open one, fold
  // any extras into it, and refresh it with this cycle's numbers.
  const [canonical, ...duplicates] = alerts;
  for (const dup of duplicates) {
    closeStarvationAlert(
      dup,
      {
        kind: "duplicate",
        evidence:
          `starvation persists and is tracked on ${canonical.id}; at most one open starvation ` +
          `alert per workspace. Live counts: open=${diagnostic!.open_beads} ready=${diagnostic!.ready_beads} ` +
          `excluded=${diagnostic!.excluded_beads}`,
      },
      workspaceRoot
    );
  }
  refreshStarvationAlert(canonical, diagnostic!, workspaceRoot);
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
        console.log(`[starvation] recovery failed; dispatching alert lifecycle`);
      }
    }
    // The lifecycle owns the alert beads: it closes the ones the live state
    // disproves, refreshes the one a persistent starvation justifies, and
    // files a new alert only when none is open. It also runs on the cycles
    // where detection returned null — that is exactly when a stale alert must
    // be closed.
    await reconcileStarvationAlerts(diagnostic);
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
