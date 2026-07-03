# Tmux Detector Event Submission Contract (tb-1hkf)

## Overview

This document specifies the complete contract for the tmux detector (`bin/trailboss-tmux-detector` → `daemon/tmux-detector.ts`) to submit events to the Trail Boss daemon.

**Note:** This contract is based on the normalized event API design decision (docs/notes/decisions.md). The daemon implementation may currently only support the legacy `/event` endpoint; see Implementation Status below.

## HTTP Request

### Endpoint

**URL:** `http://127.0.0.1:4000/event/normalized`

**Method:** `POST`

**Headers:**
```
Content-Type: application/json
```

**Configuration:** The daemon URL is configurable via `TRAILBOSS_DAEMON_URL` environment variable (default: `http://127.0.0.1:4000/event/normalized`)

## Event Payloads

The tmux detector emits four event types, each with a specific structure:

### 1. Registered Event

Emitted when a pane with `@tb-` prefix is discovered.

```json
{
  "type": "registered",
  "sessionId": "tmux-%446-1735689600000",
  "paneId": "%446",
  "cwd": "/home/coding/trail-boss",
  "transcriptPath": "",
  "timestamp": 1735689600000
}
```

**Notes:**
- `sessionId` is synthetic: `tmux-{paneId}-{timestamp}`
- `transcriptPath` is always empty (tmux detector has no transcript file)
- `cwd` is obtained via `tmux display -p -t {paneId} '#{pane_current_path}'`

### 2. Stuck Event

Emitted when pane is quiet for 30s and last line looks like a prompt.

```json
{
  "type": "stuck",
  "sessionId": "tmux-%446-1735689600000",
  "paneId": "%446",
  "cwd": "/home/coding/trail-boss",
  "transcriptPath": "",
  "reason": "stopped",
  "message": "Quiet at prompt: $ ",
  "timestamp": 1735689600000
}
```

**Notes:**
- `reason` is always `"stopped"` (tmux detector cannot distinguish permission blocks)
- `message` is the last line of pane output (for context display)
- Triggered when: `now - lastOutputTime >= QUIET_THRESHOLD_MS` AND `looksLikePrompt(output)`

### 3. Unstuck Event

Emitted when pane output changes after being stuck.

```json
{
  "type": "unstuck",
  "sessionId": "tmux-%446-1735689600000",
  "timestamp": 1735689660000
}
```

**Notes:**
- Emitted when output hash changes while `isStuck == true`
- Only `sessionId` and `timestamp` required

### 4. Ended Event

Emitted when pane is closed or `@tb-` prefix removed.

```json
{
  "type": "ended",
  "sessionId": "tmux-%446-1735689600000",
  "timestamp": 1735689660000
}
```

**Notes:**
- Emitted during graceful shutdown or when pane no longer exists
- Only `sessionId` and `timestamp` required

## Response Format

### Success Response

```http
HTTP/1.1 200 OK
Content-Type: application/json

{
  "ok": true
}
```

### Error Responses

| Status | Body Example | Description |
|--------|--------------|-------------|
| `400 Bad Request` | `{"error": "Invalid JSON"}` | Request body is not valid JSON |
| `400 Bad Request` | `{"error": "Missing type field"}` | Event payload missing `type` discriminator |
| `400 Bad Request` | `{"error": "Unknown event type"}` | Invalid `type` value |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Server-side processing error |

## Error Handling

### Detector Behavior

The detector should log errors but continue operating:

| Error Scenario | Detector Action |
|----------------|-----------------|
| Daemon not reachable | Log error, continue polling (event is lost) |
| 4xx response | Log error, continue polling (event is lost) |
| 5xx response | Log error, continue polling (event is lost) |
| Network timeout | Log error, continue polling (event is lost) |

**No retry logic** — Events are fire-and-forget. The detector's poll loop runs every 2s, so stuck state will be re-detected and re-emitted on the next cycle if needed.

### Fallback Behavior

If the daemon is down:
- Detector continues polling panes
- Detector continues tracking stuck state internally
- Events are lost, but stuck detection will recur on next poll cycle
- No exponential backoff or retry queue (keep it simple)

## Testing

### Test the daemon is running

```bash
curl http://127.0.0.1:4000/status
```

Expected response:
```json
{"status":"ok","stuckCount":0}
```

### Test event submission

```bash
# Test registered event
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "registered",
    "sessionId": "test-tmux-%446-1735689600000",
    "paneId": "%446",
    "cwd": "/home/coding/trail-boss",
    "transcriptPath": "",
    "timestamp": 1735689600000
  }'

# Test stuck event
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stuck",
    "sessionId": "test-tmux-%446-1735689600000",
    "paneId": "%446",
    "cwd": "/home/coding/trail-boss",
    "transcriptPath": "",
    "reason": "stopped",
    "message": "Quiet at prompt: $ ",
    "timestamp": 1735689600000
  }'

# Test unstuck event
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "unstuck",
    "sessionId": "test-tmux-%446-1735689600000",
    "timestamp": 1735689660000
  }'

# Test ended event
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "ended",
    "sessionId": "test-tmux-%446-1735689600000",
    "timestamp": 1735689660000
  }'
```

Expected response for all:
```json
{"ok":true}
```

### Verify queue state

```bash
curl http://127.0.0.1:4000/queue
```

### Test invalid event

```bash
curl -X POST http://127.0.0.1:4000/event/normalized \
  -H "Content-Type: application/json" \
  -d '{
    "type": "invalid_type",
    "sessionId": "test"
  }'
```

Expected response:
```json
{"error":"Invalid event: unknown type 'invalid_type'"}
```

## Implementation Status

**Current State:** As of 2026-07-02, the daemon (`daemon/index.ts`) only implements the legacy `/event` endpoint, which expects:
- `X-Tmux-Pane` header
- Raw HookEvent format (Claude Code-specific)

**Planned State:** The `/event/normalized` endpoint documented here is the design target (see docs/notes/decisions.md "Normalized event API endpoint").

**Migration Path:** The tmux detector should emit to `/event/normalized` as specified here. Until that endpoint is implemented, the detector may need to:
1. Use the legacy `/event` endpoint with adapter wrapper, OR
2. Wait for `/event/normalized` implementation

## Detector Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRAILBOSS_DAEMON_URL` | `http://127.0.0.1:4000/event/normalized` | Daemon endpoint URL |
| `TRAILBOSS_POLL_INTERVAL_MS` | `2000` | Poll cycle interval in milliseconds |
| `TRAILBOSS_QUIET_THRESHOLD_MS` | `30000` | Minimum quiet time before declaring stuck |
| `TRAILBOSS_OPT_IN_PREFIX` | `@tb-` | Pane title prefix for opt-in monitoring |
| `TMUX` | (none) | Custom tmux socket path (for test isolation) |

## Related Documents

- `docs/notes/tmux-detector-submission-contract.md` — Full comprehensive documentation (tb-ndwx)
- `docs/notes/normalized-event-schema.md` — Complete event type definitions
- `docs/notes/decisions.md` — Design rationale for normalized event endpoint
- `daemon/types.ts` — TypeScript type definitions for events
- `daemon/index.ts` — Daemon endpoint implementation
