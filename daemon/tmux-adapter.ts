// Tmux-level detector adapter: harness-agnostic fallback for detecting stuck sessions
// Watches opted-in panes via tmux and emits normalized stuck/unstuck events
import { execSync } from "child_process";

// Configuration for the detector
const QUIET_THRESHOLD_MS = 10_000; // 10 seconds of no output = considered quiet
const POLL_INTERVAL_MS = 2_000; // Check every 2 seconds
const DAEMON_URL = "http://127.0.0.1:4000/event/normalized";

// Prompt patterns that suggest a session is waiting for input
const PROMPT_PATTERNS = [
  /\$\s*$/, // bash/zsh $
  />\s*$/, // many shells >
 /#\s*$/, // root #
  /\?\s*$/, // confirmation prompt
  /\[.*?\]\s*$/, // bracketed prompts like [y/N]
  /:\s*$/, // colon prompts
];

// Pane state tracking
interface PaneState {
  paneId: string;
  lastOutput: string;
  lastOutputTime: number;
  isStuck: boolean;
  sessionId: string; // For tmux adapter, use paneId as sessionId
  cwd: string;
  transcriptPath: string | null;
}

const trackedPanes = new Map<string, PaneState>();

// Get tmux socket (support test environment)
function getTmuxCmd(): string {
  const tmuxSocket = process.env.TMUX_TEST_SOCK || "";
  return tmuxSocket ? `tmux -S ${tmuxSocket}` : "tmux";
}

// Check if a pane exists
function paneExists(paneId: string): boolean {
  try {
    const tmuxCmd = getTmuxCmd();
    const result = execSync(`${tmuxCmd} list-panes -F '#{pane_id}' -t "${paneId}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.toString().trim().includes(paneId);
  } catch {
    return false;
  }
}

// Capture pane output
function capturePane(paneId: string): string {
  try {
    const tmuxCmd = getTmuxCmd();
    const result = execSync(`${tmuxCmd} capture-pane -p -t "${paneId}"`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.toString().trim();
  } catch {
    return "";
  }
}

// Get pane cwd (requires the pane to be running a shell)
function getPaneCwd(paneId: string): string {
  try {
    const tmuxCmd = getTmuxCmd();
    // Try to get cwd via tmux's pane_current_path
    const result = execSync(`${tmuxCmd} display -p -t "${paneId}" '#{pane_current_path}'`, {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    return result.toString().trim() || "";
  } catch {
    return "";
  }
}

// Check if the last line looks like a prompt
function looksLikePrompt(output: string): boolean {
  if (!output) return false;

  const lines = output.split("\n");
  if (lines.length === 0) return false;

  const lastLine = lines[lines.length - 1].trim();
  if (lastLine.length === 0) return false;

  // Check against prompt patterns
  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return true;
    }
  }

  return false;
}

// Hash output for comparison (avoid storing full output)
function hashOutput(output: string): string {
  // Simple hash: just use first/last 50 chars + length
  // This is good enough for detecting changes
  if (!output) return "";
  const first = output.slice(0, 50);
  const last = output.length > 50 ? output.slice(-50) : "";
  return `${first.length}-${last.length}-${first.slice(0, 10)}-${last.slice(-10)}`;
}

// Emit a normalized event to the daemon
async function emitEvent(event: {
  type: "stuck" | "unstuck" | "registered" | "ended";
  sessionId: string;
  paneId: string;
  cwd?: string;
  transcriptPath?: string;
  reason?: "stopped" | "permission";
  message?: string;
  timestamp: number;
}): Promise<boolean> {
  try {
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      console.error(`[tmux-adapter] emit failed: ${response.status}`);
      return false;
    }

    return true;
  } catch (err) {
    console.error(`[tmux-adapter] emit error:`, err);
    return false;
  }
}

// Register a pane for tracking
export function registerPane(paneId: string, cwd: string = "", transcriptPath: string | null = null): void {
  if (!paneExists(paneId)) {
    console.warn(`[tmux-adapter] pane does not exist: ${paneId}`);
    return;
  }

  const now = Date.now();
  const output = capturePane(paneId);
  const sessionId = `tmux-${paneId}`; // Use paneId as session identity

  trackedPanes.set(paneId, {
    paneId,
    lastOutput: hashOutput(output),
    lastOutputTime: now,
    isStuck: false,
    sessionId,
    cwd,
    transcriptPath,
  });

  // Emit registration event
  emitEvent({
    type: "registered",
    sessionId,
    paneId,
    cwd,
    transcriptPath: transcriptPath || "",
    timestamp: now,
  });

  console.log(`[tmux-adapter] registered pane ${paneId}`);
}

// Unregister a pane from tracking
export function unregisterPane(paneId: string): void {
  const state = trackedPanes.get(paneId);
  if (!state) return;

  emitEvent({
    type: "ended",
    sessionId: state.sessionId,
    timestamp: Date.now(),
  });

  trackedPanes.delete(paneId);
  console.log(`[tmux-adapter] unregistered pane ${paneId}`);
}

// Check a single pane for stuck state
function checkPane(paneId: string, state: PaneState): void {
  // First check if pane still exists
  if (!paneExists(paneId)) {
    // Pane closed - unregister
    unregisterPane(paneId);
    return;
  }

  const now = Date.now();
  const output = capturePane(paneId);
  const outputHash = hashOutput(output);
  const outputChanged = outputHash !== state.lastOutput;

  if (outputChanged) {
    // Output changed - update state
    state.lastOutput = outputHash;
    state.lastOutputTime = now;

    // If stuck and output changed, unstuck
    if (state.isStuck) {
      state.isStuck = false;
      emitEvent({
        type: "unstuck",
        sessionId: state.sessionId,
        timestamp: now,
      });
      console.log(`[tmux-adapter] unstuck: ${state.sessionId} (output changed)`);
    }
    return;
  }

  // Output hasn't changed - check if quiet threshold exceeded
  const timeSinceOutput = now - state.lastOutputTime;
  const isQuiet = timeSinceOutput >= QUIET_THRESHOLD_MS;

  if (isQuiet && !state.isStuck) {
    // Check if it looks like a prompt
    if (looksLikePrompt(output)) {
      // Transition to stuck
      state.isStuck = true;
      emitEvent({
        type: "stuck",
        sessionId: state.sessionId,
        paneId: state.paneId,
        cwd: state.cwd,
        transcriptPath: state.transcriptPath || "",
        reason: "stopped", // Tmux adapter can't distinguish permission vs stopped
        message: output.split("\n").pop() || "[no prompt detected]",
        timestamp: now,
      });
      console.log(`[tmux-adapter] stuck: ${state.sessionId} (quiet for ${timeSinceOutput}ms)`);
    }
  } else if (!isQuiet && state.isStuck) {
    // Was stuck, but output changed recently - unstuck
    state.isStuck = false;
    emitEvent({
      type: "unstuck",
      sessionId: state.sessionId,
      timestamp: now,
    });
    console.log(`[tmux-adapter] unstuck: ${state.sessionId} (output changed)`);
  }
}

// Main poll loop
export function startPolling(): NodeJS.Timeout {
  console.log(`[tmux-adapter] started (interval ${POLL_INTERVAL_MS}ms, quiet threshold ${QUIET_THRESHOLD_MS}ms)`);

  return setInterval(() => {
    for (const [paneId, state] of trackedPanes.entries()) {
      checkPane(paneId, state);
    }
  }, POLL_INTERVAL_MS);
}

// Stop polling
export function stopPolling(intervalId: NodeJS.Timeout): void {
  clearInterval(intervalId);
  console.log("[tmux-adapter] stopped");
}

// Get list of tracked panes (for debugging)
export function getTrackedPanes(): Array<{ paneId: string; isStuck: boolean; sessionId: string }> {
  return Array.from(trackedPanes.values()).map(s => ({
    paneId: s.paneId,
    isStuck: s.isStuck,
    sessionId: s.sessionId,
  }));
}
