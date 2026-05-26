// Claude Code adapter: normalizes hook events into stuck/unstuck events
import type { HookEvent, StuckEvent, UnstuckEvent, SessionRegistered, SessionEnded } from "./types.ts";

export function adaptHookEvent(
  raw: HookEvent,
  paneId: string
): StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded | null {
  const timestamp = Date.now();

  switch (raw.hook_event_name) {
    case "Stop":
      return {
        type: "stuck",
        sessionId: raw.session_id,
        paneId,
        cwd: raw.cwd,
        transcriptPath: raw.transcript_path,
        reason: "stopped",
        message: raw.last_assistant_message ?? "[no message]",
        timestamp,
      } as StuckEvent;

    case "PermissionRequest":
      // Format tool operation for display
      const toolMsg = raw.tool_name
        ? `[${raw.tool_name}] ${formatToolInput(raw.tool_name, raw.tool_input)}`
        : "[permission request]";
      return {
        type: "stuck",
        sessionId: raw.session_id,
        paneId,
        cwd: raw.cwd,
        transcriptPath: raw.transcript_path,
        reason: "permission",
        message: toolMsg,
        timestamp,
      } as StuckEvent;

    case "UserPromptSubmit":
      return {
        type: "unstuck",
        sessionId: raw.session_id,
        timestamp,
      } as UnstuckEvent;

    case "SessionStart":
      return {
        type: "registered",
        sessionId: raw.session_id,
        paneId,
        cwd: raw.cwd,
        transcriptPath: raw.transcript_path,
        timestamp,
      } as SessionRegistered;

    case "SessionEnd":
      return {
        type: "ended",
        sessionId: raw.session_id,
        timestamp,
      } as SessionEnded;

    default:
      return null;
  }
}

function formatToolInput(toolName: string, input: unknown): string {
  if (!input) return "";
  const str = JSON.stringify(input);
  if (str.length <= 100) return str;
  return str.slice(0, 97) + "...";
}

// Type guards
export function isStuckEvent(
  event: StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded | null
): event is StuckEvent {
  return event?.type === "stuck";
}

export function isUnstuckEvent(
  event: StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded | null
): event is UnstuckEvent {
  return event?.type === "unstuck";
}

export function isSessionRegistered(
  event: StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded | null
): event is SessionRegistered {
  return event?.type === "registered";
}

export function isSessionEnded(
  event: StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded | null
): event is SessionEnded {
  return event?.type === "ended";
}
