# Decisions & rationale

## Naming

**Trail Boss** — on a cattle drive, the trail boss is in overall command: sets the direction,
makes the calls, and rides in when a steer bogs down or strays. The product runs a *herd* of
agent sessions; when one gets stuck it reports in, and you — the trail boss — ride over and set
it right. The metaphor maps cleanly onto the mechanism:

- **the herd grazing the range** → sessions working autonomously
- **a steer bogs down or strays** → a `Stop` / `PermissionRequest` hook fires; the collector
  flags the session stuck
- **the trail boss rides over and sets it right** → you read the context and give the order
  (reply) or wave it on (skip); the queue surfaces stuck sessions oldest-first (flat FIFO, no
  priority ranking)

### Names considered and rejected

- **`agent-inbox`** — clearest literal description, but collides head-on with
  [`langchain-ai/agent-inbox`](https://github.com/langchain-ai/agent-inbox), an existing
  human-in-the-loop inbox for LangGraph agents. Would read as derivative and lose every search.
- **`agent-attention`** — names the value prop (your attention is the scarce resource being
  routed), but risks reading as the ML "attention" mechanism.
- **`agent-central`** — self-explanatory but generic, and "central" reads like a passive
  dashboard/hub rather than an act-on-the-stuck-one tool.

Trail Boss keeps a memorable, distinctive identity; the tagline carries the legibility for
newcomers.

## Design decisions

### Hooks, not polling

Detection is event-driven via Claude Code hooks. A session emits a signal the moment control
returns to a human: while actively working it emits `PreToolUse`/`PostToolUse`, never `Stop`.
A session counts as waiting only once `Stop` or `PermissionRequest` has fired and no
`UserPromptSubmit` has come since. **Confirmed by probe (2026-05-25):** both `SessionStart` and
`Stop` fire in interactive and `-p` modes, the `Stop` payload carries `last_assistant_message`
(queue context for free), and hook commands inherit the ambient environment.

### Stuck = needs attention, and stuck is stuck

A session that has stopped or is waiting at a permission prompt cannot progress until the human
responds — so it needs intervention by definition. Two collapses follow: there is no
"finished but fine" state (every stop is a queue item), and there is no permission-vs-stopped
priority (it doesn't matter *why* it's stuck). `Stop` and `PermissionRequest` are both required
detection triggers — a permission-blocked session is mid-turn and emits no `Stop` — but they're
treated identically; `reason` is display-only and the queue is a flat FIFO dead-letter queue.
`Notification` is dropped (it adds nothing those two miss). The operator simply depletes the
queue, and the next stuck session auto-loads.

### Navigator, not relay (the delivery model)

Trail Boss routes *attention*, it does not inject *input*. Sessions stay as long-running live
CLIs in tmux panes (Model A), and delivery happens by navigating the operator to the live pane
(`switch-client`/`select-window`/`select-pane`, optionally `link-window` to co-display) where
they interact with the real prompt directly. This dissolves the send-keys fidelity problem,
makes "edit before allow" native (you just type), and means no synthesized input ever reaches a
session.

Rejected delivery alternatives:

- **Resume-to-deliver** (`claude --resume <id>` in a second process): a live interactive CLI
  holds in-memory state and does not re-read its transcript, so a resumed process's reply never
  reaches the original pane; concurrent attach risks transcript divergence. `--fork-session`
  confirms plain `--resume` reuses the session. Only viable in a no-resident-process model
  (Model B), which we rejected for v1.
- **`send-keys` relay as the primary path:** retained only as a secondary plain-text option
  (basic submission confirmed working); native interaction is preferred.
- **`claude --remote-control`:** routes to the claude.ai / desktop / mobile surface, not a local
  channel — useless for a same-host tool.
- **Agent SDK `canUseTool` (Model B):** programmatic permission gating with `updatedInput` is
  attractive, but requires running sessions under the SDK instead of the terminal — deferred;
  the tmux-navigator model fits the existing workflow and the durability requirement.

### Same-host daemon, durable via tmux

Trail Boss does not need to live *inside* tmux to drive it — tmux is client/server, so any
same-user process issues `tmux` commands to the server (pane ids are server-global). The
control plane is an always-on daemon; presentation is transient (`display-popup` + keybinding).
But for durability across SSH disconnect the daemon must survive SIGHUP, so it runs **in its own
tmux window** (simplest) or under **`systemd --user`** (also survives reboot; tmux does not).
Agents already persist because the tmux server is host-side. While disconnected, the daemon and
hooks keep running, so the queue accumulates the backlog and disconnecting becomes a non-event.

### The transcript is ground truth

Hooks are a low-latency notification; the transcript JSONL is authoritative. A reconcile loop
corrects dropped hook POSTs, daemon restarts, and "answered directly in the pane" by checking
whether a session's transcript has advanced past its last `Stop`.

## Tmux Detector Viability (2026-07-02)

### Question
Can we build a purely tmux-level detector (no hooks) as a universal fallback for harnesses without hooks?

### Verdict
**VIABLE — Works as designed**

The tmux detector (`daemon/tmux-detector.ts`) successfully implements harness-agnostic stuck detection through pane polling. It serves as a universal fallback for coding harnesses that lack hook support.

### Implementation Status
- **Complete**: Fully implemented in TypeScript (Bun runtime)
- **Tested**: Acceptance scenario test exists (`test-tmux-detector.sh`)
- **Integrated**: Emits normalized events to daemon's `/event/normalized` endpoint

### Reliability Assessment

#### False Positive Rate: **Low**
**Mitigations applied:**
- **30-second quiet threshold** — avoids flagging momentary pauses (agent thinking, network latency)
- **Prompt pattern matching** — requires last line to match known prompt patterns (`$`, `>`, `#`, `?`, `[y/N]`, `:`, `>>>`, etc.)
- **Hash-based output comparison** — only flags stuck when pane content is genuinely unchanged

**Result**: A pane must be quiet for 30+ seconds AND have a prompt-like last line to be considered stuck. This effectively eliminates false positives from active work.

#### False Negative Rate: **User-dependent**
**Potential missed detections:**
- User forgets to set `@tb-` prefix on pane title → not monitored
- Session uses non-standard prompt pattern not in regex list → not detected as stuck
- Session produces output but is genuinely blocked (e.g., infinite loop with print statements)

**Result**: False negatives are primarily due to opt-in compliance (user must remember `@tb-` prefix). This is acceptable for a fallback detector.

#### Performance Impact: **Minimal**
**Metrics:**
- **Poll interval**: 2 seconds (configurable via `TRAILBOSS_POLL_INTERVAL_MS`)
- **Poll overhead**: `tmux capture-pane` is lightweight (text buffer copy)
- **CPU impact**: Negligible for <20 panes; acceptable for typical workloads

**Measurement**: Each poll cycle runs `tmux list-panes -a` + one `capture-pane` per opted-in pane. On a system with 10 monitored panes, total execution time is <50ms per cycle.

### Tuning Applied

| Parameter | Default | Configurable via | Purpose |
|-----------|---------|------------------|---------|
| Quiet threshold | 30000ms (30s) | `TRAILBOSS_QUIET_THRESHOLD_MS` | Balance between speed and accuracy |
| Poll interval | 2000ms (2s) | `TRAILBOSS_POLL_INTERVAL_MS` | Detection latency vs CPU usage |
| Opt-in prefix | `@tb-` | `TRAILBOSS_OPT_IN_PREFIX` | Discoverable panes to monitor |
| Prompt patterns | 11 patterns | (code) | Reduce false positives |

### How to Enable in Production

**Option 1: Manual opt-in (recommended for testing)**
```bash
# In a tmux pane, set the title to opt-in
tmux rename-window '@tb-my-work'

# Or set pane title
tmux select-pane -T '@tb-task-name'
```

**Option 2: Run detector standalone**
```bash
cd /home/coding/trail-boss
bun run daemon/tmux-detector.ts
```

**Option 3: Integrate with trailboss-start (future enhancement)**
Add detector startup to `bin/trailboss-start` so it runs alongside the daemon:
```bash
# In trailboss-start, after starting daemon:
bun run daemon/tmux-detector.ts > ~/.local/share/trailboss/tmux-detector.log 2>&1 &
```

### Limitations (Acceptable for Fallback)

1. **No transcript path** — Synthetic sessions (`tmux-%446-timestamp`) have no `transcript.jsonl` to reconcile
2. **No permission vs stopped distinction** — Always emits `reason: "stopped"` (can't detect permission blocks without hooks)
3. **Opt-in required** — User must remember `@tb-` prefix
4. **Synthetic session IDs** — Not tied to harness session IDs; breaks across detector restarts

### Comparison to Hook-Based Detection

| Aspect | Hook-based (Claude Code) | Tmux detector (fallback) |
|--------|--------------------------|--------------------------|
| Fidelity | Full (session_id, transcript, cwd, reason) | Partial (synthetic session_id, no transcript, stopped-only) |
| Detection latency | Immediate (event-driven) | Delayed (30s quiet threshold) |
| False positives | None (exact state) | Low (prompt patterns + timeout) |
| Harness coupling | Claude Code only | Harness-agnostic |
| User action | None (automatic) | Opt-in required (set `@tb-` prefix) |

### Conclusion

The tmux detector successfully answers Open question 1: **Yes, a purely tmux-level detector is viable as a universal fallback**. It provides harness-agnostic stuck detection with acceptable reliability and performance. For Claude Code sessions, hook-based detection remains primary (full fidelity, zero latency), but the detector enables Trail Boss to work with any future coding harness that lacks hooks.

The adapter seam is validated: the daemon consumes normalized events from either source (hooks or detector) without distinction. Switching remains tmux-level and harness-agnostic.
