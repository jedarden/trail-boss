# Normalized Stuck/Unstuck Event Schema — Tmux Detector

## Overview

This document summarizes the normalized event schema for the tmux detector. The full schema specification is in **[docs/notes/normalized-event-schema.md](../notes/normalized-event-schema.md)**.

The tmux detector submits events to the `/event/normalized` endpoint using pre-normalized payloads. TypeScript interfaces are defined in **[daemon/types.ts](../../daemon/types.ts)**.

## Event Type Discriminator

All normalized events use a `type` field as a discriminated union:

```typescript
type NormalizedEvent = StuckEvent | UnstuckEvent | SessionRegistered | SessionEnded;
```

## StuckEvent

Session became stuck and needs attention. This adds the session to the queue.

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

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"stuck"` | Literal discriminator |
| `sessionId` | `string` | Unique session identifier (synthetic for tmux: `tmux-{paneId}-{timestamp}`) |
| `paneId` | `string` | tmux pane ID (e.g., `%446`) |
| `cwd` | `string` | Current working directory |
| `transcriptPath` | `string` | Path to transcript (empty string for tmux detector) |
| `reason` | `"stopped" \| "permission"` | Why stuck (tmux detector always uses `"stopped"`) |
| `message` | `string` | Context (last line of output) |
| `timestamp` | `number` | Unix milliseconds |

### Tmux Detector Example

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

## UnstuckEvent

Session resumed and is no longer stuck. This removes the session from the queue.

```typescript
interface UnstuckEvent {
  type: "unstuck";
  sessionId: string;
  timestamp: number; // Unix milliseconds
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"unstuck"` | Literal discriminator |
| `sessionId` | `string` | Must match a stuck session in queue |
| `timestamp` | `number` | Unix milliseconds |

### Tmux Detector Example

```json
{
  "type": "unstuck",
  "sessionId": "tmux-%446-1735689600000",
  "timestamp": 1735689660000
}
```

## SessionRegistered

New session discovered for monitoring. Initializes session tracking.

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

### Tmux Detector Example

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

## SessionEnded

Session terminated. Removes session from tracking and emits unstuck if stuck.

```typescript
interface SessionEnded {
  type: "ended";
  sessionId: string;
  timestamp: number;
}
```

### Tmux Detector Example

```json
{
  "type": "ended",
  "sessionId": "tmux-%446-1735689600000",
  "timestamp": 1735689720000
}
```

## Validation Rules

### Type-Level

1. `type` must be exactly `"stuck"`, `"unstuck"`, `"registered"`, or `"ended"`
2. `timestamp` must be a positive number (Unix milliseconds)
3. `sessionId` and `paneId` must be non-empty strings
4. `reason` must be exactly `"stopped"` or `"permission"`

### Business Logic

1. **Session ID consistency**: All events for a session use the same `sessionId`
2. **Pane ID consistency**: `paneId` should be consistent across events
3. **Event ordering**: `registered` → `stuck` → `unstuck` → `ended`
4. **Idempotency**: Duplicate events are handled gracefully

## Submission Endpoint

```bash
POST http://127.0.0.1:4000/event/normalized
Content-Type: application/json

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

Response: `{"ok": true}` on success.

## Tmux Detector Specifics

### Session ID Format

The tmux detector uses synthetic session IDs:

```
tmux-{paneId}-{discovery_timestamp}
```

Example: `tmux-%446-1735689600000`

### Reason Field

The tmux detector **always uses `"stopped"`** for the `reason` field. It cannot distinguish between `stopped` and `permission` reasons since it only observes output state, not hook internals.

### Transcript Path

The tmux detector always sets `transcriptPath` to `""` (empty string) since there is no Claude Code transcript for tmux sessions.

## Consistency with daemon/types.ts

This schema is consistent with the TypeScript interfaces in `daemon/types.ts`:

- ✅ `StuckEvent` interface (lines 65-74)
- ✅ `UnstuckEvent` interface (lines 89-93)
- ✅ `SessionRegistered` interface (lines 111-118)
- ✅ `SessionEnded` interface (lines 134-138)

## Related Documentation

- **Full schema:** [docs/notes/normalized-event-schema.md](../notes/normalized-event-schema.md)
- **TypeScript definitions:** [daemon/types.ts](../../daemon/types.ts)
- **API decision:** [docs/notes/tb-2tc5-api-design-decision.md](../notes/tb-2tc5-api-design-decision.md)
- **Endpoint implementation:** [daemon/index.ts](../../daemon/index.ts) (lines 99-170)

## Implementation Status

✅ **Complete** — The normalized event schema is implemented and documented:

- TypeScript types in `daemon/types.ts`
- Endpoint `/event/normalized` in `daemon/index.ts`
- Full schema documentation in `docs/notes/normalized-event-schema.md`
- Tmux detector emits normalized events (see `daemon/tmux-adapter.ts`)

---

**Bead:** tb-1fk8
**Date:** 2026-07-02
