# Analysis: Current /event Endpoint and Types

**Date:** 2026-07-02  
**Bead:** tb-4x1t  
**Task:** Analyze current /event endpoint implementation and type definitions

## Overview

The Trail Boss daemon has **TWO event ingest endpoints**:

1. **`POST /event`** - Original endpoint for Claude Code hooks (raw `HookEvent` format)
2. **`POST /event/normalized`** - Newer endpoint for harness-agnostic sources (normalized events)

## 1. Original `/event` Endpoint (lines 31-96)

### Location
`daemon/index.ts`, lines 31-96

### Input Contract

**Required Headers:**
- `X-Tmux-Pane: <pane-id>` - Tmux pane identifier (string)

**Request Body:** JSON `HookEvent` object

**Response:** `{ ok: true }` on success

### Behavior Flow

1. Extracts `paneId` from `X-Tmux-Pane` header (returns 400 if missing)
2. Parses request body as JSON (returns 400 if invalid)
3. Calls `adaptHookEvent(raw, paneId)` to normalize to a typed event
4. Routes to handler based on event type (via type guards)

### Event Routing

| Normalized Type | Action |
|-----------------|--------|
| `StuckEvent` | upsertSession → enqueue (cleanup bootstrap entry first if sessionId ≠ paneId) |
| `UnstuckEvent` | dequeue → cleanup bootstrap entry |
| `SessionRegistered` | upsertSession (no queue entry) |
| `SessionEnded` | deleteSession |

---

## 2. Normalized `/event/normalized` Endpoint (lines 99-177)

### Location
`daemon/index.ts`, lines 99-177

### Design Rationale
This endpoint accepts **pre-normalized events** with a `type` discriminator. The adapter layer (hook scripts, detector) emits normalized events; the daemon consumes only the normalized contract and has **no knowledge of harness-specific formats**.

### Input Contract

**Required Headers:** None

**Request Body:** JSON union of normalized event types:
- `StuckEvent`
- `UnstuckEvent`
- `SessionRegistered`
- `SessionEnded`

**Response:** `{ ok: true }` on success, or `{ error: "..." }` on failure

### Validation

1. Parses JSON (returns 400 if invalid)
2. Checks for `type` field (returns 400 if missing)
3. Routes by type guard (returns 400 if unknown type)

### Behavior Flow

Identical to `/event` routing logic, but without the adapter layer—events are already normalized.

---

## 3. Event Types Catalogue

### Raw HookEvent (`daemon/types.ts`, lines 4-20)

**Purpose:** Raw Claude Code hook event format

```typescript
interface HookEvent {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "Stop" | "PermissionRequest" | "UserPromptSubmit" | "SessionStart" | "SessionEnd";
  
  // Optional fields based on hook_event_name:
  permission_mode?: string;
  effort?: { level: string };
  
  // Stop-specific:
  last_assistant_message?: string;
  stop_hook_active?: boolean;
  background_tasks?: string[];
  session_crons?: string[];
  
  // PermissionRequest-specific:
  tool_name?: string;
  tool_input?: unknown;
  permission_suggestions?: Array<{ type: string; mode: string; destination: string }>;
}
```

### Normalized Event Types

#### StuckEvent (`daemon/types.ts`, lines 28-37)

```typescript
interface StuckEvent {
  type: "stuck";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  reason: "stopped" | "permission";
  message: string;  // last_assistant_message or formatted tool operation
  timestamp: number; // unix ms
}
```

#### UnstuckEvent (`daemon/types.ts`, lines 39-43)

```typescript
interface UnstuckEvent {
  type: "unstuck";
  sessionId: string;
  timestamp: number;
}
```

#### SessionRegistered (`daemon/types.ts`, lines 45-52)

```typescript
interface SessionRegistered {
  type: "registered";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  timestamp: number;
}
```

#### SessionEnded (`daemon/types.ts`, lines 54-58)

```typescript
interface SessionEnded {
  type: "ended";
  sessionId: string;
  timestamp: number;
}
```

### Queue State Types

#### QueueItem (`daemon/types.ts`, lines 61-70)

```typescript
interface QueueItem {
  id: number;
  sessionId: string;
  paneId: string;
  cwd: string;
  reason: "stopped" | "permission";
  message: string;
  stuckAt: number;
  skipCooldownUntil: number | null;
}
```

#### NextResponse (`daemon/types.ts`, lines 72-75)

```typescript
interface NextResponse {
  paneId: string | null; // null if queue empty or all on cooldown
  reason: string | null; // if null, why empty
}
```

---

## 4. Adapter Mapping (`daemon/claude-adapter.ts`)

The `adaptHookEvent()` function maps raw Claude Code hooks to normalized events:

| `hook_event_name` | Maps To | Notes |
|-------------------|---------|-------|
| `Stop` | `StuckEvent` (reason: "stopped") | Uses `last_assistant_message` or `"[no message]"` |
| `PermissionRequest` | `StuckEvent` (reason: "permission") | Formats `[toolName] toolInput` or `"[permission request]"` |
| `UserPromptSubmit` | `UnstuckEvent` | No additional data |
| `SessionStart` | `SessionRegistered` | Registers session without queue entry |
| `SessionEnd` | `SessionEnded` | Deletes session from database |

### Tool Input Formatting

The adapter truncates tool input JSON to 100 characters (with `"..."` suffix) for display purposes.

---

## Key Observations

1. **Dual Endpoint Pattern:** The daemon maintains both `/event` (Claude Code-specific) and `/event/normalized` (harness-agnostic). This was a design decision documented in `docs/notes/decisions.md`.

2. **Bootstrap Cleanup:** Both endpoints handle cleanup of synthetic "bootstrap" entries when a real `sessionId` differs from the `paneId` (lines 59-61, 132-134).

3. **Type Discriminators:** All normalized events use a `type` field for runtime type checking via type guards.

4. **Timestamps:** Normalized events include unix millisecond timestamps generated by the adapter or detector.

5. **UnstuckEvent Flexibility:** The normalized endpoint tolerates optional `paneId` on `UnstuckEvent` (lines 148-152), allowing the tmux detector to include pane context for cleanup.

---

## Related Files

- `daemon/index.ts` - HTTP server implementation (both endpoints)
- `daemon/types.ts` - All event type definitions
- `daemon/claude-adapter.ts` - Hook event normalization logic
- `docs/notes/decisions.md` - Design rationale for normalized endpoint
