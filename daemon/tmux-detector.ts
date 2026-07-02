#!/usr/bin/env bun
/**
 * Trail Boss Tmux Detector Poller
 *
 * A harness-agnostic fallback for detecting stuck coding sessions by watching
 * opted-in tmux panes. Emits normalized events to the daemon's /event/normalized endpoint.
 *
 * Opt-in: Panes must include "@tb-" prefix in their title (e.g., "@tb-feature-x")
 *
 * Usage: bun run daemon/tmux-detector.ts
 */

import { execSync } from "node:child_process";

// ============================================================================
// Configuration
// ============================================================================

const POLL_INTERVAL_MS = parseInt(process.env.TRAILBOSS_POLL_INTERVAL_MS || "") || 2000;
const QUIET_THRESHOLD_MS = parseInt(process.env.TRAILBOSS_QUIET_THRESHOLD_MS || "") || 30000;
const OPT_IN_PREFIX = process.env.TRAILBOSS_OPT_IN_PREFIX || "@tb-";
const DAEMON_URL = process.env.TRAILBOSS_DAEMON_URL || "http://127.0.0.1:4000/event/normalized";

// ============================================================================
// Types
// ============================================================================

interface PaneState {
  paneId: string;
  sessionId: string;
  cwd: string;
  lastOutputHash: string;
  lastOutputTime: number;
  isStuck: boolean;
  firstSeenAt: number;
}

interface NormalizedEvent {
  type: "stuck" | "unstuck" | "registered" | "ended";
  sessionId?: string;
  paneId?: string;
  cwd?: string;
  transcriptPath?: string;
  reason?: string;
  message?: string;
  timestamp: number;
}

// ============================================================================
// Prompt Patterns
// ============================================================================

const PROMPT_PATTERNS = [
  /\$\s*$/, // bash/zsh $
  />\s*$/, // many shells >
  /#\s*$/, // root #
  /\?\s*$/, // confirmation prompts
  /\[.*?\]\s*$/, // bracketed prompts like [y/N]
  /:\s*$/, // colon prompts
  />>>\s*$/, // Python REPL
  /\.\.\.\s*$/, // Python continuation
  />\s*\>/, // MySQL prompt
  /@/, // Augie/other shells
];

// ============================================================================
// State
// ============================================================================

const trackedPanes = new Map<string, PaneState>();
let isRunning = true;

// ============================================================================
// Logging
// ============================================================================

function log(message: string): void {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
}

// ============================================================================
// Tmux Utilities
// ============================================================================

/**
 * Discover all panes that have opted in (title starts with @tb-)
 */
function discoverOptedInPanes(): Set<string> {
  const result = new Set<string>();

  try {
    const cmd = `tmux list-panes -a -F '#{pane_id} #{pane_title}'`;
    const output = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const lines = output.split("\n");

    for (const line of lines) {
      if (!line) continue;
      const parts = line.split(" ");
      if (parts.length < 2) continue;

      const paneId = parts[0];
      const title = parts.slice(1).join(" "); // Rejoin in case title has spaces

      if (title.startsWith(OPT_IN_PREFIX)) {
        result.add(paneId);
      }
    }
  } catch (err) {
    log(`[tmux] Failed to list panes: ${err}`);
  }

  return result;
}

/**
 * Capture the visible output of a pane
 */
function capturePane(paneId: string): string {
  try {
    const cmd = `tmux capture-pane -p -t ${paneId}`;
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch (err) {
    log(`[tmux] Failed to capture pane ${paneId}: ${err}`);
    return "";
  }
}

/**
 * Check if a pane still exists
 */
function paneExists(paneId: string): boolean {
  try {
    const cmd = `tmux display -p -t ${paneId} '#{pane_id}'`;
    const output = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return output === paneId;
  } catch {
    return false;
  }
}

/**
 * Get the current working directory of a pane
 */
function getPaneCwd(paneId: string): string {
  try {
    const cmd = `tmux display -p -t ${paneId} '#{pane_current_path}'`;
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// ============================================================================
// Output Analysis
// ============================================================================

/**
 * Hash output for comparison (avoid storing full content)
 */
function hashOutput(output: string): string {
  if (!output) return "";
  const lines = output.split("\n");
  const firstLine = lines[0] || "";
  const lastLine = lines[lines.length - 1] || "";
  return `${firstLine.length}-${lastLine.length}-${lines.length}-${firstLine.slice(0, 10)}-${lastLine.slice(-10)}`;
}

/**
 * Check if the last line looks like a prompt
 */
function looksLikePrompt(output: string): boolean {
  const lines = output.split("\n");
  const lastLine = lines[lines.length - 1]?.trim() || "";

  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return true;
    }
  }

  return false;
}

/**
 * Get the last line for context
 */
function getLastLine(output: string): string {
  const lines = output.split("\n");
  return lines[lines.length - 1]?.trim() || "[no output]";
}

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit a normalized event to the daemon
 */
async function emitEvent(event: NormalizedEvent): Promise<boolean> {
  try {
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: "Unknown error" }));
      log(`[emit] Daemon error: ${response.status} - ${error.error || response.statusText}`);
      return false;
    }

    return true;
  } catch (err) {
    log(`[emit] Network error: ${err}`);
    return false;
  }
}

// ============================================================================
// Pane Lifecycle
// ============================================================================

/**
 * Register a new pane for monitoring
 */
function registerPane(paneId: string): void {
  const cwd = getPaneCwd(paneId);
  const sessionId = `tmux-${paneId}-${Date.now()}`;
  const output = capturePane(paneId);
  const hash = hashOutput(output);

  trackedPanes.set(paneId, {
    paneId,
    sessionId,
    cwd,
    lastOutputHash: hash,
    lastOutputTime: Date.now(),
    isStuck: false,
    firstSeenAt: Date.now(),
  });

  // Emit registration event
  emitEvent({
    type: "registered",
    sessionId,
    paneId,
    cwd,
    transcriptPath: "", // No transcript for synthetic sessions
    timestamp: Date.now(),
  });

  log(`[detector] registered pane ${paneId} as ${sessionId} (cwd: ${cwd})`);
}

/**
 * Untrack a pane (closed or removed prefix)
 */
function untrackPane(paneId: string): void {
  const state = trackedPanes.get(paneId);
  if (!state) return;

  emitEvent({
    type: "ended",
    sessionId: state.sessionId,
    timestamp: Date.now(),
  });

  trackedPanes.delete(paneId);
  log(`[detector] untracked pane ${paneId} (${state.sessionId})`);
}

/**
 * Check a single pane for stuck state
 */
function checkPane(paneId: string, state: PaneState): void {
  const now = Date.now();

  // 1. Verify pane still exists
  if (!paneExists(paneId)) {
    untrackPane(paneId);
    return;
  }

  // 2. Capture output
  const output = capturePane(paneId);
  const hash = hashOutput(output);
  const outputChanged = hash !== state.lastOutputHash;

  // 3. Handle output change
  if (outputChanged) {
    state.lastOutputHash = hash;
    state.lastOutputTime = now;

    // If was stuck, now unstuck
    if (state.isStuck) {
      state.isStuck = false;
      emitEvent({
        type: "unstuck",
        sessionId: state.sessionId,
        timestamp: now,
      });
      log(`[detector] unstuck: ${state.sessionId} (output changed)`);
    }

    return; // Not stuck, continue monitoring
  }

  // 4. Output hasn't changed — check quiet threshold
  const timeSinceOutput = now - state.lastOutputTime;
  const isQuiet = timeSinceOutput >= QUIET_THRESHOLD_MS;

  if (isQuiet && !state.isStuck) {
    // Quiet threshold exceeded — check if looks like prompt
    if (looksLikePrompt(output)) {
      // Transition to stuck
      state.isStuck = true;
      emitEvent({
        type: "stuck",
        sessionId: state.sessionId,
        paneId: state.paneId,
        cwd: state.cwd,
        transcriptPath: "", // No transcript for synthetic sessions
        reason: "stopped", // Tmux detector can't distinguish permission vs stopped
        message: getLastLine(output),
        timestamp: now,
      });
      log(`[detector] stuck: ${state.sessionId} (quiet for ${timeSinceOutput}ms, last line: "${getLastLine(output)}")`);
    }
  }
}

// ============================================================================
// Main Poll Loop
// ============================================================================

async function pollLoop(): Promise<void> {
  log(`[detector] starting poll loop (interval: ${POLL_INTERVAL_MS}ms, quiet threshold: ${QUIET_THRESHOLD_MS}ms)`);

  while (isRunning) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    if (!isRunning) break;

    try {
      // 1. Discover opted-in panes
      const optedInPanes = discoverOptedInPanes();

      // 2. Register new panes
      for (const paneId of optedInPanes) {
        if (!trackedPanes.has(paneId)) {
          registerPane(paneId);
        }
      }

      // 3. Untrack removed panes
      for (const paneId of trackedPanes.keys()) {
        if (!optedInPanes.has(paneId)) {
          untrackPane(paneId);
        }
      }

      // 4. Check each tracked pane
      for (const [paneId, state] of trackedPanes) {
        checkPane(paneId, state);
      }

      // Log status if we have tracked panes
      if (trackedPanes.size > 0) {
        const stuckCount = Array.from(trackedPanes.values()).filter((s) => s.isStuck).length;
        log(`[detector] poll: ${trackedPanes.size} panes tracked, ${stuckCount} stuck`);
      }
    } catch (err) {
      log(`[detector] poll error: ${err}`);
    }
  }

  log("[detector] poll loop stopped");
}

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Stop the detector gracefully
 */
export function stop(): void {
  log("[detector] shutting down...");
  isRunning = false;

  // Emit ended events for all tracked panes
  for (const [paneId, state] of trackedPanes) {
    emitEvent({
      type: "ended",
      sessionId: state.sessionId,
      timestamp: Date.now(),
    });
  }

  trackedPanes.clear();
}

// ============================================================================
// Signal Handlers
// ============================================================================

process.on("SIGINT", () => {
  log("[detector] received SIGINT");
  stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("[detector] received SIGTERM");
  stop();
  process.exit(0);
});

// ============================================================================
// Main Entry Point
// ============================================================================

async function main(): Promise<void> {
  log("[detector] Trail Boss Tmux Detector Poller starting...");
  log(`[detector] daemon URL: ${DAEMON_URL}`);
  log(`[detector] opt-in prefix: ${OPT_IN_PREFIX}`);

  await pollLoop();
}

// Run if executed directly
if (import.meta.main) {
  main().catch((err) => {
    log(`[detector] fatal error: ${err}`);
    process.exit(1);
  });
}
