# Tmux Detector Event Submission Contract (tb-1hkf)

## Overview

This document specifies the complete contract for the tmux detector (`bin/trailboss-tmux-detector` → `daemon/tmux-detector.ts`) to submit events to the Trail Boss daemon.

**Note:** This contract is based on the normalized event API design decision (docs/notes/decisions.md). The endpoint is implemented and verified live — see Implementation Status below. The legacy `/event` endpoint remains available in parallel for Claude Code hooks, which submit the raw HookEvent format with an `X-Tmux-Pane` header and are adapted server-side.

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
| `400 Bad Request` | `{"error": "Invalid or missing event type"}` | Payload is not a JSON object, or `type` is missing, empty, or not a string |
| `400 Bad Request` | `{"error": "Unknown event type"}` | `type` is a string but not one of the four supported values |
| `400 Bad Request` | `{"error": "Invalid event fields"}` | A supported event type is missing a required field or a field has an invalid value (e.g. `timestamp` not a finite number > 0, empty `sessionId`/`paneId`/`message`, `reason` other than `stopped`/`permission`) |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Server-side processing error |

A rejected request changes no session or queue state; see `docs/notes/normalized-event-contract.md` for the complete validation rules and retry semantics.

## Error Handling

### Detector Behavior

The detector should log errors but continue operating:

| Error Scenario | Detector Action |
|----------------|-----------------|
| Daemon not reachable | Log error, continue polling (event is lost) |
| 4xx response | Log error, continue polling (event is lost) |
| 5xx response | Log error, continue polling (event is lost) |
| Network timeout | Log error, continue polling (event is lost) |

**No retry logic** — Events are fire-and-forget. The detector retains its in-memory pane state and emits again when that state changes; a failed event is not resent on the next poll.

### Fallback Behavior

If the daemon is down:
- Detector continues polling panes
- Detector continues tracking stuck state internally
- Failed events are lost; later pane state changes can emit new events
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
{"error":"Unknown event type"}
```

## Implementation Status

✅ **Implemented and verified live** — `POST /event/normalized` is implemented in `daemon/index.ts` and is the endpoint the tmux detector emits to, exactly as specified above (see `docs/notes/decisions.md` "Normalized event API endpoint"). The legacy `/event` endpoint remains available in parallel for Claude Code hooks.

**Verified 2026-11-08** against the running daemon (`trailboss-daemon.service`, `http://127.0.0.1:4000`) and the daemon integration suite (`daemon/normalized-event.test.ts`, which spawns a real daemon instance and exercises every case over HTTP via `scripts/definition-of-done.sh`):

- All four event types (`registered`, `stuck`, `unstuck`, `ended`) return `200 {"ok": true}` and produce the documented state effect (registration stores the session; stuck enqueues with `reason`; unstuck dequeues and records the progress marker; ended removes the session and tombstones it).
- Validation matches `docs/notes/normalized-event-contract.md`: non-JSON body → `400 {"error": "Invalid JSON"}`; missing/empty/non-string `type` → `400 {"error": "Invalid or missing event type"}`; a string `type` outside the four supported values → `400 {"error": "Unknown event type"}`; missing or invalid fields (`timestamp` must be a finite number > 0, `sessionId`/`paneId`/`message` non-empty, `reason` exactly `stopped` or `permission`) → `400 {"error": "Invalid event fields"}`. Rejected requests change no session or queue state.
- Retries are idempotent: a duplicate event returns the same `200 {"ok": true}` without duplicating queue entries, and a retry that arrives after the session progressed (unstuck) or ended resurrects nothing (see `docs/notes/normalized-event-schema.md` retry semantics).

The earlier caveat on this page — and the `[emit] Daemon error: 404 - Not found` observed in acceptance run `tmux-detector-20260702-114229` — described the daemon as of 2026-07-02, before the endpoint was implemented on 2026-10-11. They no longer apply.

## Detector Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRAILBOSS_DAEMON_URL` | `http://127.0.0.1:4000/event/normalized` | Daemon endpoint URL |
| `TRAILBOSS_POLL_INTERVAL_MS` | `2000` | Poll cycle interval in milliseconds |
| `TRAILBOSS_QUIET_THRESHOLD_MS` | `30000` | Minimum quiet time before declaring stuck |
| `TRAILBOSS_OPT_IN_PREFIX` | `@tb-` | Pane title prefix for opt-in monitoring |
| `TRAILBOSS_TMUX_SOCKET` | (none) | Custom tmux socket path (for test isolation) |

## Related Documents

- `docs/notes/tmux-detector-submission-contract.md` — Full comprehensive documentation (tb-ndwx)
- `docs/notes/normalized-event-schema.md` — Complete event type definitions
- `docs/notes/decisions.md` — Design rationale for normalized event endpoint
- `daemon/types.ts` — TypeScript type definitions for events
- `daemon/index.ts` — Daemon endpoint implementation
