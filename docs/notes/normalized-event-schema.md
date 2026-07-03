# Normalized Event Schema

## Overview

The normalized event schema is the harness-agnostic contract between event producers (adapters, detectors) and the Trail Boss daemon. All normalized events are submitted to the `/event/normalized` endpoint and share a common structure with a `type` discriminator.

This design isolates harness coupling to the adapter layer — the daemon consumes only normalized events and has no knowledge of harness-specific formats (Claude Code hooks, tmux detector, etc.).

## Type Discriminator

All normalized events have a required `type` field that serves as a discriminated union discriminator:

```typescript
type NormalizedEvent = StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded;
```

Type guards are used to narrow the type at runtime:

```typescript
function isStuckEvent(event: unknown): event is StuckEvent {
  return (event as NormalizedEvent)?.type === "stuck";
}
```

## Event Types

### 1. StuckEvent

A session became stuck and needs attention. This is the core event that adds a session to the queue.

```typescript
interface StuckEvent {
  type: "stuck";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  reason: "stopped" | "permission";
  message: string;
  timestamp: number; // Unix milliseconds
}
```

**Required Fields:**

| Field | Type | Validation |
|-------|------|------------|
| `type` | `"stuck"` | Must be exactly `"stuck"` |
| `sessionId` | `string` | Non-empty, unique identifier for the session |
| `paneId` | `string` | tmux pane ID (e.g., `%446`) or synthetic equivalent |
| `cwd` | `string` | Current working directory (empty string if unknown) |
| `transcriptPath` | `string` | Absolute path to transcript JSONL (empty string if unknown) |
| `reason` | `"stopped" \| "permission"` | Must be exactly `"stopped"` or `"permission"` |
| `message` | `string` | Context message (e.g., last assistant message, tool name) |
| `timestamp` | `number` | Unix milliseconds, must be > 0 |

**Field Semantics:**

- `sessionId`: Unique identifier for the session. For Claude Code, this is the harness session ID. For tmux detector, this is synthetic: `tmux-{paneId}-{timestamp}`.
- `paneId`: tmux pane identifier (e.g., `%446`). Used for navigation to the stuck session.
- `cwd`: Working directory for context display. May be empty for synthetic sessions.
- `transcriptPath`: Path to the session's transcript JSONL for reconciliation. May be empty for synthetic sessions (tmux detector has no transcript).
- `reason`: Why the session is stuck. `"stopped"` = session hit a Stop hook. `"permission"` = session is waiting at a permission prompt. Tmux detector always uses `"stopped"` (cannot distinguish).
- `message`: Human-readable context. For stopped sessions, this is the last assistant message. For permission sessions, this is the tool name and input. For tmux detector, this is the last line of output.
- `timestamp`: When the stuck event occurred. Used for queue ordering and staleness detection.

**Examples:**

```typescript
// From Claude Code hooks (stopped)
{
  type: "stuck",
  sessionId: "claude-42-abc123",
  paneId: "%446",
  cwd: "/home/coding/project",
  transcriptPath: "/home/coding/.claude/sessions/abc123/transcript.jsonl",
  reason: "stopped",
  message: "The user has not responded. Waiting for input.",
  timestamp: 1735689600000
}

// From Claude Code hooks (permission)
{
  type: "stuck",
  sessionId: "claude-42-def456",
  paneId: "%447",
  cwd: "/home/coding/project",
  transcriptPath: "/home/coding/.claude/sessions/def456/transcript.jsonl",
  reason: "permission",
  message: "Tool: Bash | Command: npm install",
  timestamp: 1735689605000
}

// From tmux detector
{
  type: "stuck",
  sessionId: "tmux-%446-1735689600000",
  paneId: "%446",
  cwd: "/home/coding/project",
  transcriptPath: "",
  reason: "stopped",
  message: "Quiet at prompt: $ ",
  timestamp: 1735689600000
}
```

---

### 2. UnstuckEvent

A session progressed and is no longer stuck. This removes the session from the queue.

```typescript
interface UnstuckEvent {
  type: "unstuck";
  sessionId: string;
  timestamp: number; // Unix milliseconds
}
```

**Required Fields:**

| Field | Type | Validation |
|-------|------|------------|
| `type` | `"unstuck"` | Must be exactly `"unstuck"` |
| `sessionId` | `string` | Must match an existing session in the queue |
| `timestamp` | `number` | Unix milliseconds, must be > 0 |

**Field Semantics:**

- `sessionId`: Must match a currently stuck session. If the session is not in the queue, the event is ignored (idempotent).
- `timestamp`: When the unstuck event occurred. Used for logging and metrics.

**Examples:**

```typescript
{
  type: "unstuck",
  sessionId: "claude-42-abc123",
  timestamp: 1735689660000
}
```

---

### 3. SessionRegistered

A new session has been registered for monitoring. This initializes session tracking.

```typescript
interface SessionRegistered {
  type: "registered";
  sessionId: string;
  paneId: string;
  cwd: string;
  transcriptPath: string;
  timestamp: number; // Unix milliseconds
}
```

**Required Fields:**

| Field | Type | Validation |
|-------|------|------------|
| `type` | `"registered"` | Must be exactly `"registered"` |
| `sessionId` | `string` | Non-empty, unique identifier for the session |
| `paneId` | `string` | tmux pane ID (e.g., `%446`) or synthetic equivalent |
| `cwd` | `string` | Current working directory (empty string if unknown) |
| `transcriptPath` | `string` | Absolute path to transcript JSONL (empty string if unknown) |
| `timestamp` | `number` | Unix milliseconds, must be > 0 |

**Field Semantics:**

- `sessionId`: Unique identifier for the session. Used to associate subsequent stuck/unstuck events with this registration.
- `paneId`: tmux pane identifier for navigation.
- `cwd`: Working directory for context display.
- `transcriptPath`: Path to the session's transcript JSONL for reconciliation.
- `timestamp`: When the session was registered.

**Examples:**

```typescript
// From Claude Code adapter
{
  type: "registered",
  sessionId: "claude-42-abc123",
  paneId: "%446",
  cwd: "/home/coding/project",
  transcriptPath: "/home/coding/.claude/sessions/abc123/transcript.jsonl",
  timestamp: 1735689600000
}

// From tmux detector
{
  type: "registered",
  sessionId: "tmux-%446-1735689600000",
  paneId: "%446",
  cwd: "/home/coding/project",
  transcriptPath: "",
  timestamp: 1735689600000
}
```

---

### 4. SessionEnded

A session has terminated. This removes the session from tracking and emits an unstuck event if the session was stuck.

```typescript
interface SessionEnded {
  type: "ended";
  sessionId: string;
  timestamp: number; // Unix milliseconds
}
```

**Required Fields:**

| Field | Type | Validation |
|-------|------|------------|
| `type` | `"ended"` | Must be exactly `"ended"` |
| `sessionId` | `string` | Must match a tracked session |
| `timestamp` | `number` | Unix milliseconds, must be > 0 |

**Field Semantics:**

- `sessionId`: Must match a currently tracked session. If the session is not tracked, the event is ignored (idempotent).
- `timestamp`: When the session ended.

**Examples:**

```typescript
{
  type: "ended",
  sessionId: "claude-42-abc123",
  timestamp: 1735689660000
}
```

---

## Validation Rules

### Type-Level Validation

1. **Type field must be a valid literal**: `"stuck" | "unstuck" | "registered" | "ended"`
2. **Timestamp must be positive**: `timestamp > 0`
3. **String fields must be non-empty** where specified (sessionId, paneId)
4. **Enum fields must match exact values**: `reason` must be `"stopped" | "permission"`

### Business Logic Validation

1. **Session ID consistency**: All events for the same session must use the same `sessionId`
2. **Pane ID consistency**: `paneId` should be consistent across registered/stuck events for the same session
3. **Event ordering**: `registered` → `stuck` → `unstuck` → `ended` (unstuck may repeat, ended is terminal)
4. **Idempotency**: Duplicate events are handled gracefully:
   - Duplicate `stuck`: Updates the queue entry (new timestamp, message)
   - Duplicate `unstuck`: No-op if session not in queue
   - Duplicate `registered`: Updates pane/cwd/transcript metadata
   - Duplicate `ended`: No-op if session not tracked

### Type-Specific Rules

#### StuckEvent

- `paneId` is required for navigation (cannot be empty)
- `reason` must be `"stopped"` or `"permission"` (no other values)
- `message` should be non-empty (used for queue display)
- `cwd` may be empty for synthetic sessions
- `transcriptPath` may be empty for synthetic sessions

#### UnstuckEvent

- `sessionId` must match a currently stuck session (ignored otherwise)
- Only `sessionId` and `timestamp` are required (minimal payload)

#### SessionRegistered

- `paneId` is required (cannot be empty)
- `cwd` may be empty
- `transcriptPath` may be empty

#### SessionEnded

- `sessionId` must match a tracked session (ignored otherwise)
- Only `sessionId` and `timestamp` are required (minimal payload)

## Error Handling

### Invalid Events

The daemon `/event/normalized` endpoint returns `400 Bad Request` for:

1. Missing required fields
2. Invalid type literals (e.g., `type: "stuckk"`)
3. Invalid enum values (e.g., `reason: "blocked"`)
4. Invalid timestamps (e.g., `timestamp: -1` or `timestamp: "2024-01-01"`)
5. Malformed JSON

Error response format:

```json
{
  "error": "Invalid event: missing required field 'sessionId'"
}
```

### Out-of-Order Events

The daemon handles out-of-order events gracefully:

1. **Unstuck before stuck**: Ignored (session not in queue)
2. **Ended before registered**: Ignored (session not tracked)
3. **Stuck after ended**: Ignored (session no longer tracked)

### Unknown Event Types

Events with unknown `type` values are rejected with `400 Bad Request`:

```json
{
  "error": "Invalid event: unknown type 'paused'"
}
```

## Usage Examples

### Submitting to the Daemon

```bash
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stuck",
    "sessionId": "claude-42-abc123",
    "paneId": "%446",
    "cwd": "/home/coding/project",
    "transcriptPath": "/home/coding/.claude/sessions/abc123/transcript.jsonl",
    "reason": "stopped",
    "message": "The user has not responded. Waiting for input.",
    "timestamp": 1735689600000
  }'
```

### Type Guards in TypeScript

```typescript
function handleEvent(event: unknown): void {
  if (isStuckEvent(event)) {
    // TypeScript knows event is StuckEvent
    addToQueue(event);
  } else if (isUnstuckEvent(event)) {
    // TypeScript knows event is UnstuckEvent
    removeFromQueue(event.sessionId);
  } else if (isSessionRegistered(event)) {
    // TypeScript knows event is SessionRegistered
    trackSession(event);
  } else if (isSessionEnded(event)) {
    // TypeScript knows event is SessionEnded
    untrackSession(event.sessionId);
  }
}
```

## Implementation Status

✅ **Complete** — The normalized event schema is implemented in:

- `daemon/types.ts` — TypeScript type definitions
- `daemon/index.ts` — `/event/normalized` endpoint handler (lines 99-170)
- `daemon/tmux-detector.ts` — Emits normalized events to `/event/normalized`
- `daemon/claude-adapter.ts` — Emits normalized events to `/event/normalized`

## See Also

- `daemon/types.ts` — Source type definitions
- `docs/notes/decisions.md` — Design rationale for normalized event API
- `daemon/index.ts` — Endpoint implementation
