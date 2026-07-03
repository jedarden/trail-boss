// Normalized event types for the harness-agnostic adapter contract
//
// This design isolates harness coupling to the adapter layer — the daemon consumes
// only normalized events and has no knowledge of harness-specific formats.
//
// Full schema documentation: docs/notes/normalized-event-schema.md
// Design rationale: docs/notes/decisions.md (section "Normalized event API endpoint")

// ============================================================================
// Raw Hook Events (Claude Code-specific)
// ============================================================================

// Raw hook events from Claude Code (what the emitter POSTs)
export interface HookEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "Stop" | "PermissionRequest" | "UserPromptSubmit" | "SessionStart" | "SessionEnd";
  permission_mode?: string;
  effort?: { level: string };
  // Stop-specific
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  background_tasks?: string[];
  session_crons?: string[];
  // PermissionRequest-specific
  tool_name?: string;
  tool_input?: unknown;
  permission_suggestions?: Array<{ type: string; mode: string; destination: string }>;
}

// ============================================================================
// Normalized Events (harness-agnostic)
// ============================================================================

// Type union for all normalized events
export type NormalizedEvent = StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded;

// The normalized stuck/unstuck event that the daemon consumes
// This isolates harness coupling to the adapter layer
//
// All normalized events have a `type` discriminator for use with type guards.
// The /event/normalized endpoint accepts these pre-normalized events directly
// from harness-specific adapters (Claude Code hooks, tmux detector, etc.).

/**
 * StuckEvent — A session became stuck and needs attention.
 *
 * This is the core event that adds a session to the queue. When a session hits
 * a Stop hook or PermissionRequest, the adapter emits this event to queue the
 * session for operator attention.
 *
 * Validation rules:
 * - type: Must be exactly "stuck"
 * - sessionId: Non-empty string, unique identifier
 * - paneId: Non-empty string, tmux pane ID (e.g., "%446")
 * - cwd: String, may be empty for synthetic sessions
 * - transcriptPath: String, may be empty for synthetic sessions
 * - reason: Must be "stopped" or "permission"
 * - message: Non-empty string, human-readable context
 * - timestamp: Positive number, Unix milliseconds
 *
 * See: docs/notes/normalized-event-schema.md#1-stuckevent
 */
export interface StuckEvent {
  type: "stuck";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  reason: "stopped" | "permission";
  message: string; // last_assistant_message or tool_name+input
  timestamp: number; // unix ms
}

/**
 * UnstuckEvent — A session progressed and is no longer stuck.
 *
 * This removes the session from the queue. When a session resumes (user
 * submits a prompt, or permission is granted), the adapter emits this event.
 *
 * Validation rules:
 * - type: Must be exactly "unstuck"
 * - sessionId: Must match a stuck session in the queue (ignored otherwise)
 * - timestamp: Positive number, Unix milliseconds
 *
 * See: docs/notes/normalized-event-schema.md#2-unstuckevent
 */
export interface UnstuckEvent {
  type: "unstuck";
  sessionId: string;
  timestamp: number;
}

/**
 * SessionRegistered — A new session has been registered for monitoring.
 *
 * This initializes session tracking. The adapter emits this when a new session
 * is discovered (e.g., SessionStart hook, or tmux pane with @tb- prefix).
 *
 * Validation rules:
 * - type: Must be exactly "registered"
 * - sessionId: Non-empty string, unique identifier
 * - paneId: Non-empty string, tmux pane ID
 * - cwd: String, may be empty
 * - transcriptPath: String, may be empty
 * - timestamp: Positive number, Unix milliseconds
 *
 * See: docs/notes/normalized-event-schema.md#3-sessionregistered
 */
export interface SessionRegistered {
  type: "registered";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  timestamp: number;
}

/**
 * SessionEnded — A session has terminated.
 *
 * This removes the session from tracking and emits an unstuck event if the
 * session was stuck. The adapter emits this when a session ends (e.g., SessionEnd
 * hook, or tmux pane closed).
 *
 * Validation rules:
 * - type: Must be exactly "ended"
 * - sessionId: Must match a tracked session (ignored otherwise)
 * - timestamp: Positive number, Unix milliseconds
 *
 * See: docs/notes/normalized-event-schema.md#4-sessionended
 */
export interface SessionEnded {
  type: "ended";
  sessionId: string;
  timestamp: number;
}

// Queue state
export interface QueueItem {
  id: number;
  sessionId: string;
  paneId: string;
  cwd: string;
  reason: "stopped" | "permission";
  message: string;
  stuckAt: number;
  skipCooldownUntil: number | null;
}

export interface NextResponse {
  paneId: string | null; // null if queue empty or all on cooldown
  reason: string | null; // if null, why empty
}
