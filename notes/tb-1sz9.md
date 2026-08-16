# tb-1sz9: Tmux-Level Stuck Detector Poller

## Summary

Completed the tmux-level stuck detector poller implementation. The detector watches opted-in tmux panes and emits stuck/unstuck events to the daemon using the normalized event contract.

## Implementation

The canonical implementation is TypeScript:

**Location:** `daemon/tmux-detector.ts`

**Key features:**
- Standalone poller that runs every 2 seconds (configurable via `TRAILBOSS_POLL_INTERVAL_MS`)
- Detects panes with `@tb-` prefix in their title (configurable via `TRAILBOSS_OPT_IN_PREFIX`)
- Uses 30-second quiet threshold before declaring stuck (configurable via `TRAILBOSS_QUIET_THRESHOLD_MS`)
- Emits normalized events to `/event/normalized` endpoint
- Graceful shutdown on SIGINT/SIGTERM
- Auto-discovers opted-in panes via `tmux list-panes -a`

**Opt-in mechanism:**
Panes must include `@tb-` prefix in their title to be monitored. Example:
```bash
tmux rename-window '@tb-feature-x: working on authentication'
```

**Prompt detection patterns:**
```javascript
const PROMPT_PATTERNS = [
  /\$\s*$/,   // bash/zsh $
  />\s*$/,    // many shells >
  /#\s*$/,    // root #
  /\?\s*$/,   // confirmation prompts
  /\[.*?\]\s*$/, // bracketed prompts like [y/N]
  /:\s*$/,    // colon prompts
  />>>\s*$/,  // Python REPL
  /\.\.\.\s*$/, // Python continuation
  />\s*\>/,   // MySQL prompt
  /@/,        // Augie/other shells
];
```

**Running:**
```bash
bun run daemon/tmux-detector.ts
```

The earlier Go prototype was retired on 2026-08-15. It had no supported launcher or build
target, was not part of the documented setup, and used a separate `@trailboss-monitor` pane
option. The TypeScript detector is the only supported tmux detector.

## Acceptance Criteria

- ✅ Code exists and is documented
- ✅ Can detect stuck state in tmux panes
- ✅ Submits events to daemon endpoint using normalized format

## Testing

The TypeScript implementation has comprehensive acceptance tests in `test-tmux-detector.sh`:
- Auto-discovers panes with `@tb-` prefix
- Registers panes for tracking
- Detects stuck state when quiet at a prompt
- Enqueues with `reason='stopped'`
- Detects activity and unstucks/dequeues

## Normalized Event Contract

The detector emits events to `POST /event/normalized`:

**StuckEvent:**
```json
{
  "type": "stuck",
  "sessionId": "tmux-%446-1234567890",
  "paneId": "%446",
  "cwd": "/home/coding/project",
  "transcriptPath": "",
  "reason": "stopped",
  "message": "$",
  "timestamp": 1234567890
}
```

**UnstuckEvent:**
```json
{
  "type": "unstuck",
  "sessionId": "tmux-%446-1234567890",
  "timestamp": 1234567900
}
```

**SessionRegistered:**
```json
{
  "type": "registered",
  "sessionId": "tmux-%446-1234567890",
  "paneId": "%446",
  "cwd": "/home/coding/project",
  "transcriptPath": "",
  "timestamp": 1234567890
}
```

**SessionEnded:**
```json
{
  "type": "ended",
  "sessionId": "tmux-%446-1234567890",
  "timestamp": 1234567900
}
```

## Related Documentation

- `docs/notes/tmux-detector-design.md` - Full design specification
- `docs/notes/normalized-event-schema.md` - Event schema documentation
- `docs/notes/tmux-detector-submission-contract.md` - Event submission contract

## Notes

The normalized event contract and acceptance coverage remain provided by the TypeScript
implementation. For consistency, future detector work should use its pane-title opt-in and
configuration environment variables.
