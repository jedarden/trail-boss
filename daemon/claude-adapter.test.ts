import { describe, expect, test } from "bun:test";
import { adaptHookEvent, isSessionEnded, isSessionRegistered, isStuckEvent, isUnstuckEvent } from "./claude-adapter.ts";
import type { HookEvent } from "./types.ts";

function hookEvent(overrides: Partial<HookEvent> = {}): HookEvent {
  return {
    session_id: "sess-abc",
    transcript_path: "/tmp/transcript.jsonl",
    cwd: "/home/coding/trail-boss",
    hook_event_name: "UserPromptSubmit",
    ...overrides,
  };
}

describe("adaptHookEvent", () => {
  test("maps UserPromptSubmit to an unstuck event for the hook's session", () => {
    const event = adaptHookEvent(hookEvent(), "%446");
    expect(isUnstuckEvent(event)).toBe(true);
    expect(event).toEqual({
      type: "unstuck",
      sessionId: "sess-abc",
      timestamp: expect.any(Number),
    });
  });

  test("unstuck timestamp is set, not derived from the payload", () => {
    const event = adaptHookEvent(hookEvent(), "%446");
    expect(isUnstuckEvent(event) && event.timestamp).toBeGreaterThan(0);
  });

  test("maps Stop to a stopped stuck event", () => {
    const event = adaptHookEvent(
      hookEvent({ hook_event_name: "Stop", last_assistant_message: "Done. Anything else?" }),
      "%446"
    );
    expect(isStuckEvent(event)).toBe(true);
    expect(event).toMatchObject({
      type: "stuck",
      sessionId: "sess-abc",
      paneId: "%446",
      reason: "stopped",
      message: "Done. Anything else?",
    });
  });

  test("maps PermissionRequest to a permission stuck event with the formatted tool call", () => {
    const event = adaptHookEvent(
      hookEvent({
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      }),
      "%446"
    );
    expect(isStuckEvent(event)).toBe(true);
    expect(event).toMatchObject({
      type: "stuck",
      reason: "permission",
      message: '[Bash] {"command":"ls -la"}',
    });
  });

  test("maps SessionStart and SessionEnd to registered/ended", () => {
    expect(adaptHookEvent(hookEvent({ hook_event_name: "SessionStart" }), "%446")).toMatchObject({
      type: "registered",
      sessionId: "sess-abc",
    });
    expect(adaptHookEvent(hookEvent({ hook_event_name: "SessionEnd" }), "%446")).toMatchObject({
      type: "ended",
      sessionId: "sess-abc",
    });
  });

  test("returns null for unsupported hook events", () => {
    expect(adaptHookEvent(hookEvent({ hook_event_name: "PreToolUse" as never }), "%446")).toBeNull();
    expect(adaptHookEvent(hookEvent({ hook_event_name: "Notification" as never }), "%446")).toBeNull();
  });
});

describe("type guards", () => {
  test("guards partition the adapter results", () => {
    const unstuck = adaptHookEvent(hookEvent(), "%446");
    expect(isUnstuckEvent(unstuck)).toBe(true);
    expect(isStuckEvent(unstuck)).toBe(false);
    expect(isSessionRegistered(unstuck)).toBe(false);
    expect(isSessionEnded(unstuck)).toBe(false);

    const stuck = adaptHookEvent(hookEvent({ hook_event_name: "Stop" }), "%446");
    expect(isStuckEvent(stuck)).toBe(true);
    expect(isUnstuckEvent(stuck)).toBe(false);

    expect(isUnstuckEvent(null)).toBe(false);
    expect(isStuckEvent(null)).toBe(false);
  });
});
