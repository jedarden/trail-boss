# Normalized Event API: Approach Comparison (Bead tb-9k49)

**Date:** 2026-07-02  
**Context:** Evaluating architecture for harness-agnostic event ingestion in Trail Boss daemon

## Background

The Trail Boss daemon needs to accept events from multiple sources:
- **Claude Code hooks** (primary): Emits `HookEvent` with harness-specific fields
- **Tmux detector** (fallback): Harness-agnostic stuck detection via pane polling
- **Future harnesses**: May have different event formats

The daemon's core queue logic should remain **harness-agnostic** while supporting multiple detection sources.

---

## Two Approaches Considered

### Option 1: Dedicated Normalized Endpoint

**Architecture:**
```
┌─────────────────┐    normalize    ┌──────────────────┐
│ Claude hooks    │ ──────────────> │ /event/normalized │
│ Tmux detector   │ ──────────────> │                  │
│ (future sources)│ ──────────────> │                  │
└─────────────────┘                 └────────┬─────────┘
                                             │
                                             v
                                    ┌─────────────────┐
                                    │  Daemon core    │
                                    │  (queue logic)  │
                                    └─────────────────┘
```

**Implementation:**
- Single `/event/normalized` endpoint accepting pre-normalized events
- Event types defined in `daemon/types.ts`: `StuckEvent`, `UnstuckEvent`, `SessionRegistered`, `SessionEnded`
- Each event has a `type` discriminator for type-safe routing
- Adapters live at emission sites (hook scripts, detector)
- Daemon consumes only normalized contract

**Example normalized event:**
```json
{
  "type": "stuck",
  "sessionId": "cli-session-123",
  "paneId": "%456",
  "cwd": "/home/coding/project",
  "transcriptPath": "/home/coding/.claude/sessions/cli-session-123/transcript.jsonl",
  "reason": "permission",
  "message": "[Bash] sudo apt-get update",
  "timestamp": 1735689600000
}
```

### Option 2: Server-Side Adapter Wrapper

**Architecture:**
```
┌─────────────────┐    raw events    ┌──────────────────┐
│ Claude hooks    │ ──────────────> │   /event         │
│ Tmux detector   │ ──────────────> │                  │
│ (future sources)│ ──────────────> │  Server-side     │
└─────────────────┘                 │  adapter layer   │
                                    └────────┬─────────┘
                                             │
                                             v
                                    ┌─────────────────┐
                                    │  Daemon core    │
                                    │  (queue logic)  │
                                    └─────────────────┘
```

**Implementation:**
- Single `/event` endpoint accepting multiple raw event formats
- Server-side adapters wrap each harness format into a common internal representation
- Header-based routing or content inspection to select adapter
- Daemon maintains knowledge of all harness-specific formats

**Example routing logic:**
```typescript
if (headers["x-event-source"] === "claude-hooks") {
  event = adaptClaudeHookEvent(raw);
} else if (headers["x-event-source"] === "tmux-detector") {
  event = adaptTmuxDetectorEvent(raw);
} else {
  // Auto-detect by schema inspection
  event = adaptBySchemaDetection(raw);
}
```

---

## Comparison

### Separation of Concerns

| Aspect | Option 1 (Normalized Endpoint) | Option 2 (Server Adapter) |
|--------|-------------------------------|----------------------------|
| **Adapter location** | Emission site (hook script, detector) | Daemon server |
| **Daemon knowledge** | Knows only normalized contract | Knows all harness formats |
| **Coupling** | Harness coupling isolated to adapters | Daemon coupled to all harnesses |
| **Testing** | Synthetic events directly testable | Must construct harness-specific payloads |

**Winner: Option 1** — The daemon remains truly harness-agnostic. Adding a new harness doesn't require touching daemon code.

### Protocol Complexity

| Aspect | Option 1 (Normalized Endpoint) | Option 2 (Server Adapter) |
|--------|-------------------------------|----------------------------|
| **Routing mechanism** | Type field (`"type": "stuck"`) | Headers or schema inspection |
| **Validation** | Single schema per event type | Multiple schemas, one per harness |
| **Type safety** | Discriminated unions, type guards | Runtime type checking, auto-detection |
| **Error messages** | Clear validation errors | Ambiguous ("unknown format") |

**Winner: Option 1** — Discriminated unions provide compile-time type safety and clear runtime validation.

### Extensibility

| Aspect | Option 1 (Normalized Endpoint) | Option 2 (Server Adapter) |
|--------|-------------------------------|----------------------------|
| **Adding new harness** | Write new emitter, post to `/event/normalized` | Add server adapter, deploy daemon |
| **Breaking changes** | Isolated to emitter implementation | May require daemon redeployment |
| **Versioning** | Emitter version independent of daemon | Daemon must support all active versions |
| **Deployment** | Emitters can be deployed independently | Daemon is single point of deployment |

**Winner: Option 1** — New harnesses don't require daemon changes. Emit and iterate independently.

### Testability

| Aspect | Option 1 (Normalized Endpoint) | Option 2 (Server Adapter) |
|--------|-------------------------------|----------------------------|
| **Synthetic events** | POST normalized JSON directly | Must construct harness-specific payload |
| **Unit testing** | Test with normalized events only | Test each adapter path separately |
| **Integration tests** | Single endpoint contract | Multiple contracts to validate |
| **Debugging** | Clear event structure | May need to understand multiple formats |

**Winner: Option 1** — Simplifies testing and debugging with a single, well-documented contract.

### Alignment with daemon/types.ts

| Aspect | Option 1 (Normalized Endpoint) | Option 2 (Server Adapter) |
|--------|-------------------------------|----------------------------|
| **Type definitions** | `StuckEvent`, `UnstuckEvent`, etc. ARE the API | Additional adapter types needed |
| **Import graph** | Clean: types → endpoint | types → adapters → endpoint |
| **Type guard usage** | Direct (`isStuckEvent(event)`) | After adapter transformation |
| **Schema documentation** | Single source of truth | Multiple schemas (harness + normalized) |

**Winner: Option 1** — `daemon/types.ts` already defines normalized events as the internal contract. Option 1 makes this contract public without additional transformation layers.

### Drawbacks

**Option 1 drawbacks:**
- More upfront work: each emitter must implement normalization
- Duplicate normalization logic if multiple emitters for same harness
- Emission site responsible for format compliance

**Option 2 drawbacks:**
- Daemon becomes a format translation layer (violates separation of concerns)
- Each new harness requires daemon changes
- Server complexity increases with each harness supported
- Testing requires mocking multiple event formats

---

## Recommendation: Option 1 (Normalized Endpoint)

### Rationale

**Option 1 is the correct choice** for Trail Boss because:

1. **Separation of concerns**: The daemon's job is queue management, not format translation. Harness coupling belongs at the emission site, not in the daemon.

2. **Future extensibility**: Adding a new harness (Cursor, Windsurf, etc.) should not require modifying the daemon. Emit normalized events and the daemon handles them.

3. **Type safety**: Discriminated unions with a `type` field provide compile-time guarantees and runtime clarity. No header-based routing or schema auto-detection required.

4. **Testability**: Synthetic events can be POSTed directly without understanding harness-specific payloads. Simplifies integration testing.

5. **Alignment with existing design**: `daemon/types.ts` already defines `StuckEvent`, `UnstuckEvent`, `SessionRegistered`, and `SessionEnded` as the internal contract. Option 1 makes this the public API without additional layers.

6. **Independent deployment**: Emitteurs can be versioned and deployed independently. A bug fix in the Claude hook adapter doesn't require a daemon redeployment.

### Implementation Status

✅ **Complete** — Option 1 is already implemented:
- Endpoint: `POST /event/normalized` in `daemon/index.ts` (lines 99-177)
- Type definitions: `daemon/types.ts` (lines 28-58)
- Type guards: `daemon/claude-adapter.ts` (lines 76-98)
- Emitters: 
  - Claude hooks: `.claude/trailboss-emit.sh`
  - Tmux detector: `daemon/tmux-adapter.ts`

### When to Use Option 2 Instead

Option 2 (server-side adapters) would be preferable **only if**:
- The daemon needs to normalize events from sources it cannot control (e.g., third-party webhooks with fixed schemas)
- Emission sites cannot be modified to emit normalized events
- A single unchangeable format must be supported

This does not apply to Trail Boss: we control both the hook script and the tmux detector, so we can emit normalized events directly.

---

## Conclusion

Option 1's normalized endpoint is the right architectural choice for Trail Boss. It maintains clean separation between detection (harness-coupled) and queue logic (harness-agnostic), provides type-safe event routing, and enables independent evolution of emitters and daemon core.

The implementation is complete and validated by the tmux detector acceptance tests. Future harnesses should follow the same pattern: emit normalized events to `/event/normalized` and the daemon will handle them without modification.
