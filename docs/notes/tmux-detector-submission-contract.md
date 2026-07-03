# Tmux Detector Event Submission Contract

## Overview

The tmux detector (`daemon/tmux-detector.ts`) submits normalized stuck/unstuck events to the Trail Boss daemon's `/event/normalized` endpoint. This document specifies the complete submission contract.

## Endpoint

**URL:** `http://127.0.0.1:4000/event/normalized`

**Method:** `POST`

**Content-Type:** `application/json`

**Configuration:** The daemon URL is configurable via `TRAILBOSS_DAEMON_URL` environment variable (default: `http://127.0.0.1:4000/event/normalized`)

## Request Format

### HTTP Request

```http
POST /event/normalized HTTP/1.1
Host: 127.0.0.1:4000
Content-Type: application/json

<event-payload-json>
```

### Event Payloads

The tmux detector emits four event types, each with a specific structure:

#### 1. Registered Event (when pane with `@tb-` prefix is discovered)

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

#### 2. Stuck Event (when pane is quiet for 30s and last line looks like a prompt)

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

#### 3. Unstuck Event (when pane output changes after being stuck)

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

#### 4. Ended Event (when pane is closed or `@tb-` prefix removed)

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
| `400 Bad Request` | `{"error": "Unknown event type"}` | Invalid `type` value (not `stuck`/`unstuck`/`registered`/`ended`) |
| `500 Internal Server Error` | `{"error": "Internal server error"}` | Server-side processing error |

## Detector Behavior

### Polling Cycle

The detector runs a poll loop every 2 seconds (configurable via `TRAILBOSS_POLL_INTERVAL_MS`):

1. **Discover opted-in panes** via `tmux list-panes -a -F '#{pane_id} #{pane_title}'`
2. **Register new panes** that have `@tb-` prefix in title
3. **Untrack removed panes** that no longer have `@tb-` prefix
4. **Check each tracked pane** for stuck state:
   - Capture output via `tmux capture-pane -p -t {paneId}`
   - Hash output for comparison
   - Check quiet threshold (30s default)
   - Check if last line looks like a prompt
   - Emit `stuck` event if conditions met
   - Emit `unstuck` event if output changes while stuck

### Graceful Shutdown

On `SIGINT` or `SIGTERM`, the detector:
1. Emits `ended` event for all tracked panes
2. Clears the pane tracking state
3. Exits cleanly

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `TRAILBOSS_DAEMON_URL` | `http://127.0.0.1:4000/event/normalized` | Daemon endpoint URL |
| `TRAILBOSS_POLL_INTERVAL_MS` | `2000` | Poll cycle interval in milliseconds |
| `TRAILBOSS_QUIET_THRESHOLD_MS` | `30000` | Minimum quiet time before declaring stuck |
| `TRAILBOSS_OPT_IN_PREFIX` | `@tb-` | Pane title prefix for opt-in monitoring |
| `TMUX` | (none) | Custom tmux socket path (for test isolation) |

## Error Handling

The detector logs errors but continues operating:

| Error Scenario | Log Message | Behavior |
|----------------|-------------|----------|
| Daemon not reachable | `[emit] Network error: ...` | Event lost, continues polling |
| Invalid JSON response | `[emit] Daemon error: 400 - ...` | Event lost, continues polling |
| tmux command fails | `[tmux] Failed to capture pane ...` | Skips pane this cycle, retries next cycle |
| Poll cycle error | `[detector] poll error: ...` | Logs error, continues next cycle |

## Integration Example

### Starting the detector alongside the daemon

```bash
# Terminal 1: Start the daemon
cd /home/coding/trail-boss
bun run daemon/index.ts

# Terminal 2: Start the tmux detector
cd /home/coding/trail-boss
bun run daemon/tmux-detector.ts
```

### Opt-in a tmux pane for monitoring

```bash
# In any tmux pane, set the title to opt-in
tmux rename-window '@tb-feature-work'

# Or set pane title
tmux select-pane -T '@tb-task-name'
```

### Verify events are being submitted

Check detector logs for emission events:

```
[2024-07-02T12:34:56.789Z] [detector] registered pane %12 as tmux-%12-1719987600000 (cwd: /home/coding/project)
[2024-07-02T12:35:26.789Z] [detector] stuck: tmux-%12-1719987600000 (quiet for 30000ms, last line: "$ ")
[2024-07-02T12:35:30.789Z] [detector] unstuck: tmux-%12-1719987600000 (output changed)
[2024-07-02T12:36:00.789Z] [detector] untracked pane %12 (tmux-%12-1719987600000)
```

Check daemon logs for received events:

```
[normalized] registered: tmux-%12-1 -> %12
[normalized] stuck: tmux-%12-1 (stopped)
[normalized] unstuck: tmux-%12-1
[normalized] ended: tmux-%12-1
```

## Related Documents

- `docs/notes/normalized-event-contract.md` — General normalized event API contract
- `docs/notes/normalized-event-schema.md` — Complete event type definitions
- `docs/notes/decisions.md` — Design rationale for normalized event endpoint
- `daemon/types.ts` — TypeScript type definitions for events
- `daemon/index.ts` — Daemon endpoint implementation
- `daemon/tmux-detector.ts` — Detector implementation

## Implementation Status

✅ **Complete** — The tmux detector emits normalized events to `/event/normalized` as documented above. See `daemon/tmux-detector.ts` lines 220-239 for the `emitEvent()` implementation.
