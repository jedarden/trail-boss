# Normalized Event Contract

## Overview

The Trail Boss daemon accepts normalized events via the `POST /event/normalized` endpoint. This contract is **harness-agnostic** — any adapter can emit these events to integrate a coding harness with Trail Boss, regardless of the underlying AI provider or session model.

## Endpoint

### POST /event/normalized

**URL:** `http://127.0.0.1:4000/event/normalized`

**Content-Type:** `application/json`

**Authentication:** None (localhost-only daemon)

**Request Body:** A JSON object representing one of the event types below. All events include a `type` discriminator field.

**Response (Success):**
```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true
}
```

**Error Responses:**

| Status | Body | Description |
|--------|------|-------------|
| 400 | `{"error": "Invalid JSON"}` | Request body is not valid JSON |
| 400 | `{"error": "Invalid or missing event type"}` | Missing or invalid `type` field |
| 500 | `{"error": "Internal server error"}` | Server-side processing error |

## Event Types

All events share a common structure with a `type` discriminator. The daemon dispatches based on this field.

### StuckEvent

Emitted when a session becomes stuck (blocked on user input).

**Type Discriminator:** `"stuck"`

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"stuck"` |
| `sessionId` | string | Yes | Unique session identifier (harness-specific) |
| `paneId` | string | Yes | tmux pane identifier (e.g., `%3`) |
| `cwd` | string | Yes | Current working directory of the session |
| `transcriptPath` | string | Yes | Path to the session transcript file |
| `reason` | string | Yes | Either `"stopped"` (hook event) or `"permission"` (tool blocked) |
| `message` | string | Yes | Human-readable context: last assistant message (stopped) or tool operation (permission) |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |

**Example (stopped):**
```json
{
  "type": "stuck",
  "sessionId": "sess_01a2b3c4d5e6f7g8",
  "paneId": "%12",
  "cwd": "/home/coding/project",
  "transcriptPath": "/home/coding/.claude/sessions/sess_01a2b3c4d5e6f7g8/transcript.jsonl",
  "reason": "stopped",
  "message": "I'm waiting for you to review these changes before proceeding.",
  "timestamp": 1719987600000
}
```

**Example (permission):**
```json
{
  "type": "stuck",
  "sessionId": "sess_01a2b3c4d5e6f7g8",
  "paneId": "%12",
  "cwd": "/home/coding/project",
  "transcriptPath": "/home/coding/.claude/sessions/sess_01a2b3c4d5e6f7g8/transcript.jsonl",
  "reason": "permission",
  "message": "[Bash] {\"command\":\"rm -rf /tmp/cache\"}",
  "timestamp": 1719987600000
}
```

### UnstuckEvent

Emitted when a session becomes unstuck (user provided input or the session resumed).

**Type Discriminator:** `"unstuck"`

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"unstuck"` |
| `sessionId` | string | Yes | Unique session identifier (must match a previously stuck session) |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |

**Example:**
```json
{
  "type": "unstuck",
  "sessionId": "sess_01a2b3c4d5e6f7g8",
  "timestamp": 1719987660000
}
```

**Note:** The daemon automatically looks up the `paneId` from the stored session state for cleanup.

### SessionRegistered

Emitted when a new session starts. Registers the session metadata with the daemon.

**Type Discriminator:** `"registered"`

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"registered"` |
| `sessionId` | string | Yes | Unique session identifier (harness-specific) |
| `paneId` | string | Yes | tmux pane identifier (e.g., `%3`) |
| `cwd` | string | Yes | Current working directory of the session |
| `transcriptPath` | string | Yes | Path to the session transcript file |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |

**Example:**
```json
{
  "type": "registered",
  "sessionId": "sess_01a2b3c4d5e6f7g8",
  "paneId": "%12",
  "cwd": "/home/coding/project",
  "transcriptPath": "/home/coding/.claude/sessions/sess_01a2b3c4d5e6f7g8/transcript.jsonl",
  "timestamp": 1719987600000
}
```

### SessionEnded

Emitted when a session terminates. Cleans up session state from the daemon.

**Type Discriminator:** `"ended"`

**Fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `type` | string | Yes | Must be `"ended"` |
| `sessionId` | string | Yes | Unique session identifier |
| `timestamp` | number | Yes | Unix timestamp in milliseconds |

**Example:**
```json
{
  "type": "ended",
  "sessionId": "sess_01a2b3c4d5e6f7g8",
  "timestamp": 1719988000000
}
```

## Deriving Fields from Harness Context

This section explains how to derive the normalized event fields from common harness contexts.

### sessionId

The session identifier is harness-specific. Common sources:

| Harness | Session ID Source |
|---------|-------------------|
| Claude Code | Transcript filename or internal session UUID |
| Aider | Thread ID or workspace session key |
| Cursor | VS Code workspace URI + session UUID |
| Custom | Generate a UUID or use thread/conversation ID |

**Key properties:**
- Must be unique per session (across restarts of the same session)
- Should be stable for the lifetime of the session
- Can be a UUID, hash, or harness-provided ID

### paneId

The tmux pane identifier in the form `%<number>`. Derive from:

**Method 1: Environment variable (recommended)**
```bash
# The TMUX_PANE env var is set automatically in tmux sessions
echo $TMUX_PANE  # Outputs: %12
```

**Method 2: tmux command**
```bash
# Get the pane ID of the current tmux session
tmux display -p '#{pane_id}'  # Outputs: %12
```

**Method 3: Parsing tmux socket path**
```bash
# Extract from TMUX env var
tmux show-env | grep TMUX_PANE
```

### cwd

The current working directory of the session.

**Method 1: Direct API (if harness provides it)**
```javascript
// Claude Code example
const cwd = session.cwd;
```

**Method 2: Environment variable**
```bash
# In the session's shell context
pwd
```

**Method 3: Infer from transcript path**
```bash
# If transcript path is /home/user/.claude/sessions/.../transcript.jsonl
# The session may have been invoked from the project root
```

### transcriptPath

The path to the session transcript file. This is used by the reconcile loop for recovery.

**Common patterns:**

| Harness | Transcript Path Pattern |
|---------|------------------------|
| Claude Code | `$HOME/.claude/sessions/<sessionId>/transcript.jsonl` |
| Aider | Project directory `.aider.transcript.md` or `.aider.cache/<thread>/transcript` |
| Cursor | `$HOME/.cursor/sessions/<sessionId>/transcript.jsonl` |
| Custom | Adapter-defined location |

**Claude Code example:**
```javascript
// From hook event payload
const transcriptPath = hookEvent.transcript_path;
// "/home/coding/.claude/sessions/sess_01a2b3c4d5e6f7g8/transcript.jsonl"
```

### timestamp

Unix timestamp in milliseconds. Use the current time when emitting the event.

```javascript
const timestamp = Date.now();
```

## Adapter Implementation Example

Here's a minimal adapter skeleton for a hypothetical harness:

```typescript
interface NormalizedEvent {
  type: "stuck" | "unstuck" | "registered" | "ended";
}

async function emitEvent(event: NormalizedEvent): Promise<void> {
  const response = await fetch("http://127.0.0.1:4000/event/normalized", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Trail Boss error: ${error.error}`);
  }
}

// When session starts
await emitEvent({
  type: "registered",
  sessionId: getSessionId(),
  paneId: process.env.TMUX_PANE,
  cwd: process.cwd(),
  transcriptPath: getTranscriptPath(),
  timestamp: Date.now(),
});

// When session blocks on permission
await emitEvent({
  type: "stuck",
  sessionId: getSessionId(),
  paneId: process.env.TMUX_PANE,
  cwd: process.cwd(),
  transcriptPath: getTranscriptPath(),
  reason: "permission",
  message: `[${toolName}] ${JSON.stringify(toolInput)}`,
  timestamp: Date.now(),
});

// When user provides input
await emitEvent({
  type: "unstuck",
  sessionId: getSessionId(),
  timestamp: Date.now(),
});

// When session ends
await emitEvent({
  type: "ended",
  sessionId: getSessionId(),
  timestamp: Date.now(),
});
```

## Validation

The daemon validates events at runtime:

1. **JSON validity:** Request body must be parseable JSON
2. **Type discriminator:** The `type` field must be one of: `stuck`, `unstuck`, `registered`, `ended`
3. **Required fields:** Each event type must include its required fields (see table above)

Additional validation (field formats, sessionId existence) may be added in future versions.

## Error Handling

Adapters should handle errors gracefully:

| Scenario | Recommended Handling |
|----------|---------------------|
| Daemon not running | Log warning, queue event locally, or retry with backoff |
| Invalid event type | Log error, fix adapter code |
| Missing required field | Log error, fix adapter code |
| Network error | Retry with exponential backoff, batch pending events |

## Versioning

This contract corresponds to Trail Boss daemon v1.0. Future versions may:

- Add optional fields to existing events (backward compatible)
- Add new event types (backward compatible)
- Introduce a version header for breaking changes

For breaking changes, the daemon will version the endpoint (e.g., `/event/normalized/v2`).
