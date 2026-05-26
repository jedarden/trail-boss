// Normalized event types for the harness-agnostic adapter contract

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

// The normalized stuck/unstuck event that the daemon consumes
// This isolates harness coupling to the adapter layer
export interface StuckEvent {
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  reason: "stopped" | "permission";
  message: string; // last_assistant_message or tool_name+input
  timestamp: number; // unix ms
}

export interface UnstuckEvent {
  sessionId: string;
  timestamp: number;
}

export interface SessionRegistered {
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  timestamp: number;
}

export interface SessionEnded {
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
