# API Endpoint Design Decision: Tmux Adapter Normalized Events

## Decision: Option 1 — Dedicated `/event/normalized` Endpoint

**Chosen Approach:** Add a new endpoint `/event/normalized` that accepts pre-normalized stuck/unstuck events.

## The Two Options

### Option 1: New `/event/normalized` endpoint (CHOSEN)
- Dedicated endpoint for normalized events
- Adapters emit pre-normalized `StuckEvent` / `UnstuckEvent` / `SessionRegistered` / `SessionEnded` payloads
- Daemon validates and processes normalized events directly

### Option 2: Server-side adapter wrapper (REJECTED)
- Reuse existing `/event` endpoint
- Tmux detector wraps events in Claude hook format
- Daemon runs second adapter to unwrap Claude format → normalized events

## Rationale for Choosing Option 1

### 1. Separation of Concerns
The existing `/event` endpoint is **Claude Code-specific**. It requires:
- `X-Tmux-Pane` header (hook-specific environment capture)
- `HookEvent` payload format (Claude Code hook schema)
- `adaptHookEvent()` adapter to normalize

A dedicated `/event/normalized` endpoint separates **harness-specific detection** from **harness-agnostic core processing**. This aligns with the plan's stated architecture (see `docs/plan/plan.md` "Layering: harness-coupled detection vs. harness-agnostic core").

### 2. Adapter Simplicity
Option 1 requires adapters to emit clean, simple JSON matching the domain model:
```json
{
  "type": "stuck",
  "sessionId": "tmux-%12-1234567890",
  "paneId": "%12",
  "cwd": "/home/coding/project",
  "transcriptPath": "",
  "reason": "stopped",
  "message": "waiting for input",
  "timestamp": 1719987600000
}
```

Option 2 would require adapters to synthesize Claude hook payloads:
```json
{
  "session_id": "tmux-%12-1234567890",
  "transcript_path": "",
  "cwd": "/home/coding/project",
  "hook_event_name": "Stop",
  "last_assistant_message": "waiting for input",
  "stop_hook_active": true
}
```
Plus an `X-Tmux-Pane` header. This is **leaky abstraction** — the adapter needs to know Claude's hook schema.

### 3. Future-Proofing for Multiple Harnesses
The plan explicitly states: *"Adapters produce that normalized event however they can"*. With Option 1, each harness implements its adapter once and emits normalized events. The daemon doesn't need a per-harness adapter chain.

With Option 2, every new harness would need:
1. Adapter to wrap events in Claude hook format (which doesn't fit non-Claude harnesses)
2. Server-side adapter to unwrap Claude format back to normalized

This is an unnecessary round-trip through a representation that's Claude-specific.

### 4. Validation & Error Clarity
With `/event/normalized`, the daemon validates normalized event schemas directly. Errors are clear: "missing field `reason`" vs. "invalid HookEvent format → unwrap → validation".

### 5. Testability
Normalized events are easier to test in isolation:
```bash
# Direct test
curl -X POST http://localhost:4000/event/normalized -d '{
  "type": "stuck",
  "sessionId": "test-123",
  "paneId": "%99",
  "cwd": "/tmp",
  "transcriptPath": "",
  "reason": "stopped",
  "message": "test",
  "timestamp": 1719987600000
}'
```

With Option 2, every test needs to synthesize Claude hook payloads.

## Implementation Status

**COMPLETE** — The `/event/normalized` endpoint is implemented in `daemon/index.ts` (lines 99-170).

### Endpoint Details

- **Path:** `/event/normalized`
- **Method:** `POST`
- **Content-Type:** `application/json`
- **Authentication:** None (localhost-only daemon)
- **Request Body:** Normalized event object (see `docs/notes/normalized-event-contract.md`)
- **Response:** `{"ok": true}` on success

### Accepted Event Types

| Type | Purpose | Required Fields |
|------|---------|-----------------|
| `stuck` | Session blocked on user input | `type`, `sessionId`, `paneId`, `cwd`, `transcriptPath`, `reason`, `message`, `timestamp` |
| `unstuck` | Session resumed | `type`, `sessionId`, `timestamp` |
| `registered` | New session started | `type`, `sessionId`, `paneId`, `cwd`, `transcriptPath`, `timestamp` |
| `ended` | Session terminated | `type`, `sessionId`, `timestamp` |

Full event schema documented in `docs/notes/normalized-event-contract.md`.

## How Tmux Detector Submits Events

The tmux detector (`daemon/tmux-detector.ts`) uses this endpoint:

```typescript
const DAEMON_URL = "http://127.0.0.1:4000/event/normalized";

async function emitEvent(event: NormalizedEvent): Promise<boolean> {
  const response = await fetch(DAEMON_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return response.ok;
}
```

### Emitted Events

| Trigger | Event Type | Example Payload |
|---------|-----------|-----------------|
| Pane discovered with `@tb-` prefix | `registered` | `{"type":"registered","sessionId":"tmux-%12-123","paneId":"%12",...}` |
| Quiet 30s + prompt detected | `stuck` | `{"type":"stuck","sessionId":"tmux-%12-123","paneId":"%12","reason":"stopped",...}` |
| Output changed after stuck | `unstuck` | `{"type":"unstuck","sessionId":"tmux-%12-123","timestamp":...}` |
| Pane closed | `ended` | `{"type":"ended","sessionId":"tmux-%12-123","timestamp":...}` |

## Relationship to Original `/event` Endpoint

The original `/event` endpoint remains for **Claude Code hook compatibility**:

| Endpoint | Purpose | Input Format | Adapter |
|----------|---------|--------------|---------|
| `/event` | Claude Code hooks (legacy) | `HookEvent` + `X-Tmux-Pane` header | `adaptHookEvent()` in `daemon/claude-adapter.ts` |
| `/event/normalized` | Harness-agnostic adapters | `StuckEvent` / `UnstuckEvent` / etc. | None (direct processing) |

Both endpoints write to the same database tables and queue. The daemon does not distinguish event origin after ingestion.

## Migration Path for Future Adapters

Future harness adapters should:

1. **Use `/event/normalized` directly** — emit normalized event payloads
2. **Reference `daemon/types.ts`** for TypeScript event interfaces
3. **Reference `docs/notes/normalized-event-contract.md`** for full contract specification
4. **Handle daemon downtime gracefully** — log errors, retry with backoff, queue locally

Do NOT:
- Emit Claude hook format (unless building a Claude Code adapter)
- Expect the `X-Tmux-Pane` header to be required (it's `/event`-specific)
- Wrap events in another representation

## Conclusion

Option 1 was chosen because it:
- Separates harness-specific detection from harness-agnostic core processing
- Simplifies adapter implementations (clean JSON, no header synthesis)
- Scales to multiple harnesses without adapter chains
- Improves error clarity and testability
- Aligns with the stated architecture in the plan

The implementation is complete and documented. The `/event/normalized` endpoint is the canonical API for all future harness integrations.
