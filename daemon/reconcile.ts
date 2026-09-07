// Transcript reconcile loop: the transcript JSONL is ground truth
import * as fs from "fs";
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
    const openBeads = openResult.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

    // Get ready (pluck-visible) bead count (parse JSONL format)
    const readyResult = execSync(`cd "${workspaceRoot}" && ${BEAD_BIN} list --ready --json --limit ${BEAD_LIST_LIMIT} 2>/dev/null`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    // Parse JSONL format: split by newlines and parse each line as a JSON object
    const readyBeads = readyResult.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));

    const openCount = openBeads.length;
    const readyCount = readyBeads.length;
    const excludedCount = openCount - readyCount;

    // No starvation if there are no open beads, or if all open beads are ready
    if (openCount === 0 || excludedCount === 0) {
      return null;
    }

    console.log(`[starvation] detected: ${openCount} open beads, ${readyCount} ready beads, ${excludedCount} excluded`);

    // Analyze exclusion reasons (bead list --json returns already-parsed objects)
    const exclusionReasons: string[] = [];
    for (const bead of openBeads) {
      if (bead.assignee && bead.assignee !== "null") {
        exclusionReasons.push(`bead ${bead.id} assigned to ${bead.assignee}`);
      }
      if (bead.manual_blocked) {
        exclusionReasons.push(`bead ${bead.id} manually blocked`);
      }
      if (bead.status === "in_progress") {
        exclusionReasons.push(`bead ${bead.id} in progress`);
      }
    }

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
