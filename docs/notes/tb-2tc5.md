# Normalized Event API Endpoint Decision

## Decision

**Chosen Approach:** Add a new `/event/normalized` endpoint that accepts pre-normalized stuck/unstuck events.

## Rationale

We chose a separate `/event/normalized` endpoint over wrapping tmux events in the Claude hook format for these reasons:

1. **Separation of Concerns**: The adapter layer is responsible for normalization. Different sources (Claude hooks, tmux detector, future harnesses) should emit normalized events directly, not be coupled to Claude-specific data structures.

2. **Future-Proofing**: If we add support for other AI coding agents (Cursor, Copilot, etc.), they would each need to implement their own adapter. The normalized contract is the stable interface — we expose it directly rather than forcing adapters to wrap their events in Claude's format.

3. **Consistency**: The normalized types (`StuckEvent`, `UnstuckEvent`, `SessionRegistered`, `SessionEnded`) are already the internal model of the daemon. Exposing this as an API aligns the interface with the implementation.

4. **Cleaner Adapter Code**: Tmux detectors and future adapters emit clean, purpose-built events rather than constructing fake Claude hook payloads with unused fields.

## Implementation

### Endpoint Path
`POST /event/normalized`

### Payload Format

The endpoint accepts pre-normalized events matching the `NormalizedEvent` union type from `daemon/types.ts`:

```typescript
type NormalizedEvent =
  | StuckEvent       // Session became stuck
  | UnstuckEvent     // Session resumed
  | SessionRegistered // New session registered
  | SessionEnded;    // Session terminated
```

### Event Schemas

#### 1. StuckEvent
```typescript
{
  type: "stuck",
  sessionId: string,
  paneId: string,
  cwd: string,
  transcriptPath: string,
  reason: "stopped" | "permission",
  message: string,
  timestamp: number // unix ms
}
```

#### 2. UnstuckEvent
```typescript
{
  type: "unstuck",
  sessionId: string,
  timestamp: number // unix ms
}
```

#### 3. SessionRegistered
```typescript
{
  type: "registered",
  sessionId: string,
  paneId: string,
  cwd: string,
  transcriptPath: string,
  timestamp: number // unix ms
}
```

#### 4. SessionEnded
```typescript
{
  type: "ended",
  sessionId: string,
  timestamp: number // unix ms
}
```

### Response

On success: `{ ok: true }` with HTTP 200

On error: `{ error: string }` with HTTP 400/500

## How Tmux Detector Submits Events

The tmux detector (`daemon/tmux-detector.ts`) posts directly to the normalized endpoint:

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

## Architecture Alignment

This decision aligns with the documented architecture:

- **Plan**: `docs/plan/plan.md` specifies that daemon input should be normalized events
- **Types**: `daemon/types.ts` already defines normalized event types
- **Adapter Contract**: The normalized contract is harness-agnostic by design
- **Claude Adapter**: The existing `/event` endpoint continues to accept Claude hook payloads and uses `adaptHookEvent()` to normalize them

## Related Files

- `daemon/index.ts` - HTTP server with both `/event` (Claude hooks) and `/event/normalized` (pre-normalized) endpoints
- `daemon/types.ts` - Normalized event type definitions
- `daemon/claude-adapter.ts` - Claude hook to normalized event adapter
- `daemon/tmux-detector.ts` - Tmux detector posting to `/event/normalized`
- `docs/notes/normalized-event-schema.md` - Full schema documentation
