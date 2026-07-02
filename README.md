# Trail Boss

**Single-pane attention router for interactive AI coding agents.** When you run multiple
Claude Code (or other AI coding CLI) sessions in parallel tmux panes, Trail Boss surfaces the
ones waiting on you — a FIFO queue of stuck sessions — and jumps you directly to them with a
keystroke.

---

## The problem

Running many agent sessions in tmux means manually cycling windows to find the one that needs
you. Each stalled session — hitting a permission gate, asking a question, or finishing its
turn — sits blocked until you notice it. With five or ten parallel sessions, most of your
attention goes to *finding* the stuck one, not *answering* it.

Trail Boss eliminates the cycling. Every session that stalls raises its hand automatically.
You see one prioritized queue, respond in the live pane, and move on.

**Human on the loop, not in it.** The happy path never touches you. Only stalled work routes
to you; you process the exception and it goes back on the wire.

---

## How it works

Trail Boss integrates with Claude Code via hooks and tmux pane tracking:

1. **Hook emitter** — Claude Code fires `Stop` and `PermissionRequest` hooks whenever a session
   blocks. The emitter script (`trailboss-emit.sh`) POSTs each event to the daemon with the
   current `$TMUX_PANE` ID.

2. **Daemon** (Bun + SQLite, `localhost:4000`) — Maintains a session registry and FIFO queue.
   Sessions enter the queue on `Stop`/`PermissionRequest` and leave when `UserPromptSubmit`
   fires (you typed something in the pane) or when the reconcile loop detects the transcript
   advanced on its own.

3. **TUI** (Go + Bubble Tea) — Split-panel view: queue list on the left, session detail on the
   right. Auto-refreshes every 3 seconds. Press `Enter` to jump to the head pane, `s` to skip
   it (30 s cooldown before it re-surfaces).

4. **Live preview** — A `tmux capture-pane` preview of the selected session updates in a pane
   below the TUI as you navigate the queue.

```
┌─ Trail Boss ─────────────────── 3 stuck ──┐ ┌─ Detail ───────────────────────────────┐
│ ▶ alpha    permission   2m14s              │ │ Wants to run:                          │
│   bravo    stopped      0m48s              │ │ terraform apply -target=module.lb      │
│   delta    stopped      0m11s              │ │                                        │
│                                            │ │ CWD: ~/infra/modules                   │
│ [enter] jump  [s] skip  [r] refresh  [?]  │ │ stuck 2m14s ago                        │
└────────────────────────────────────────────┘ └────────────────────────────────────────┘
```

---

## Architecture

```
Claude Code session (tmux pane)
    │  Stop / PermissionRequest hook
    ▼
.claude/trailboss-emit.sh  ─── POST /event ──►  daemon (Bun + SQLite, :4000)
                                                    │  reconcile loop (5 s)
                                                    │  GET /queue  /next  /skip
                                                    ▼
                                                TUI (Go + Bubble Tea)
                                                bin/trailboss-tui
                                                    │  tmux switch-client / select-pane
                                                    ▼
                                                Target pane (live Claude Code session)
```

---

## Detection methods

Trail Boss supports two detection methods:

### 1. Hook-based detection (primary)

Claude Code fires `Stop` and `PermissionRequest` hooks whenever a session blocks. The emitter script (`trailboss-emit.sh`) POSTs each event to the daemon with the current `$TMUX_PANE` ID. This provides:

- **Immediate detection**: Event-driven, no polling delay
- **Full fidelity**: Includes session_id, transcript path, cwd, reason (permission vs stopped)
- **Zero configuration**: Automatic for all Claude Code sessions with hooks enabled

### 2. Tmux detector (fallback)

For coding harnesses without hook support, Trail Boss includes a **tmux-level detector** (`daemon/tmux-detector.ts`) that polls opted-in panes for stuck state. This provides:

- **Harness-agnostic**: Works with any coding tool that runs in a tmux pane
- **Low false positives**: 30-second quiet threshold + prompt pattern matching
- **Opt-in required**: Panes must include `@tb-` prefix in their title

**Enabling the tmux detector:**

```bash
# Method 1: Manual opt-in per pane
tmux rename-window '@tb-my-work'
tmux select-pane -T '@tb-task-name'

# Method 2: Run detector standalone
cd /home/coding/trail-boss
bun run daemon/tmux-detector.ts

# Method 3: Integrate with trailboss-start (automatic startup)
# Edit bin/trailboss-start to add detector startup after daemon
```

**Configuration:**

| Parameter | Environment Variable | Default |
|-----------|---------------------|---------|
| Poll interval | `TRAILBOSS_POLL_INTERVAL_MS` | 2000ms (2s) |
| Quiet threshold | `TRAILBOSS_QUIET_THRESHOLD_MS` | 30000ms (30s) |
| Opt-in prefix | `TRAILBOSS_OPT_IN_PREFIX` | `@tb-` |
| Daemon URL | `TRAILBOSS_DAEMON_URL` | `http://127.0.0.1:4000/event/normalized` |
| Tmux socket | `TMUX` | `tmux` |

**Operational considerations:**

- **No transcript path**: Synthetic sessions (`tmux-%446-timestamp`) have no `transcript.jsonl` for reconcile
- **No permission vs stopped distinction**: Always emits `reason: "stopped"`
- **Opt-in compliance**: Users must remember the `@tb-` prefix
- **Detection latency**: ~30s quiet threshold vs immediate hook-based detection
- **Multi-server discovery**: Detector polls all tmux servers on the system (correct behavior for production use)
- **Graceful shutdown**: SIGINT/SIGTERM emit `ended` events for all tracked panes

For Claude Code sessions, hook-based detection is primary (full fidelity, zero latency). The tmux detector enables Trail Boss to work with any future coding harness that lacks hooks. See `docs/notes/decisions.md` for full viability analysis and test results.

---

## Components

| Component | Language | Purpose |
|-----------|----------|---------|
| `daemon/` | TypeScript (Bun) | HTTP event ingestion, SQLite state, queue API |
| `daemon/tmux-detector.ts` | TypeScript (Bun) | Harness-agnostic fallback detector via pane polling |
| `tui/` | Go (Bubble Tea) | Split-panel TUI dashboard |
| `bin/trailboss` | Shell | CLI: `jump-next`, `skip`, `popup`, `return` |
| `bin/trailboss-tui` | Go binary | TUI binary (build from tui/ with Go) |
| `bin/trailboss-start` | Shell | Launches daemon + TUI in a `trail-boss` tmux session |
| `bin/trailboss-preview` | Shell | Live pane capture loop for the split-view preview |
| `bin/trailboss-status` | Shell | tmux status-bar segment showing stuck count |
| `.claude/trailboss-emit.sh` | Shell | Hook emitter wired into Claude Code settings |

---

## Requirements

- [Bun](https://bun.sh) — daemon runtime
- tmux
- Claude Code with hooks enabled (for primary detection)
- Go 1.24+ — for building the TUI

---

## Setup

### 1. Install daemon dependencies

```bash
cd /path/to/trail-boss
bun install
```

### 2. Build the TUI

```bash
cd /path/to/trail-boss/tui
go build -o ../bin/trailboss-tui .
```

The `bin/trailboss-start` script will automatically build the TUI if the binary is missing.

### 3. Wire Claude Code hooks

Add to your project's `.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{
      "type": "command",
      "command": "/path/to/trail-boss/.claude/trailboss-emit.sh"
    }],
    "PermissionRequest": [{
      "type": "command",
      "command": "/path/to/trail-boss/.claude/trailboss-emit.sh"
    }],
    "UserPromptSubmit": [{
      "type": "command",
      "command": "/path/to/trail-boss/.claude/trailboss-emit.sh"
    }],
    "SessionStart": [{
      "type": "command",
      "command": "/path/to/trail-boss/.claude/trailboss-emit.sh"
    }],
    "SessionEnd": [{
      "type": "command",
      "command": "/path/to/trail-boss/.claude/trailboss-emit.sh"
    }]
  }
}
```

### 3. Start Trail Boss

```bash
bin/trailboss-start
```

This creates (or reuses) a `trail-boss` tmux session with two windows: `daemon` and
`dashboard`. The dashboard shows the TUI on top (60%) and a live pane preview below (40%).

### 4. Navigate

From inside any tmux session:

| Keybinding | Action |
|------------|--------|
| `prefix+Tab` | Jump to next stuck session |
| `prefix+S` | Skip current head, jump to next |
| `prefix+g` | Open queue picker popup |
| `prefix+B` | Return to Trail Boss dashboard |

Or source the provided `tmux.conf` to get these bindings:

```bash
tmux source-file /path/to/trail-boss/tmux.conf
```

### 5. Add to tmux status bar (optional)

```conf
set -g status-right "#(bin/trailboss-status) | %H:%M"
```

The segment shows `⚠ N` when N sessions are stuck, blank otherwise.

---

## TUI keys

| Key | Action |
|-----|--------|
| `j` / `k` | Move cursor down / up |
| `gg` / `G` | Jump to top / bottom |
| `Ctrl+d` / `Ctrl+u` | Half-page down / up |
| `Enter` | Jump to selected pane |
| `s` | Skip selected session (30 s cooldown) |
| `l` / `Tab` | Focus detail pane |
| `J` / `K` | Scroll detail pane |
| `1`–`9` | Jump directly to queue position N |
| `r` | Force refresh |
| `?` | Toggle help overlay |
| `q` | Quit |

---

## Repository layout

```
trail-boss/
├── daemon/
│   ├── index.ts          # HTTP server + event ingest endpoint
│   ├── claude-adapter.ts # Hook event normalization
│   ├── db.ts             # SQLite state layer
│   ├── reconcile.ts      # Transcript-advance reconcile loop
│   ├── schema.sql        # Database schema
│   ├── types.ts          # Shared types
│   └── tmux-detector.ts  # Harness-agnostic fallback detector
├── tui/
│   ├── main.go           # Entry point (AltScreen + mouse)
│   ├── model.go          # Bubble Tea model + split layout
│   ├── client.go         # Daemon HTTP client + tmux navigation
│   └── theme.go          # Dracula palette + dumb-terminal fallback
├── bin/
│   ├── trailboss         # CLI: jump-next, skip, popup, return
│   ├── trailboss-tui     # TUI binary (build from tui/ with Go)
│   ├── trailboss-start   # Session launcher
│   ├── trailboss-bootstrap # Initial setup script
│   ├── trailboss-popup   # Queue picker popup (box-drawing UI)
│   ├── trailboss-preview # Live pane capture loop
│   ├── trailboss-status  # tmux status segment
│   └── trailboss-watch   # (deprecated, superseded by TUI)
├── docs/
│   └── plan/plan.md      # Complete design spec
├── .claude/
│   └── trailboss-emit.sh # Hook emitter
└── tmux.conf             # Keybinding configuration
```

---

## Status

Phases 1–9 complete. All 7 acceptance scenarios pass end-to-end. Tmux detector fallback implemented and tested.

**What works:**
- Hook detection: `Stop` and `PermissionRequest` enqueue; `UserPromptSubmit` dequeues
- Tmux detector fallback: harness-agnostic stuck detection via pane polling (opt-in via `@tb-` prefix)
- FIFO ordering with skip cooldown (30 s before a skipped session re-surfaces)
- Reconcile loop: sessions dequeue automatically when transcripts advance (even if
  `UserPromptSubmit` was missed because the daemon was temporarily down)
- Self-healing registry: a session reappearing in a different pane re-registers
- No forced focus-steal: resolving a session does not auto-switch you to another
- TUI resolves pane IDs to human-readable tmux session names (alpha, bravo, etc.)

**Upcoming:** refinements from daily use.

---

## Design principles

**Stuck is stuck.** Whether a session hit a permission gate or just finished its turn —
both mean "blocked until you act." The queue treats them identically; `reason` is
display-only metadata, never a routing input.

**Navigator, not relay.** Trail Boss routes your attention to the live session. You interact
with the real CLI directly. It never injects replies or relays input.

**Not a fleet spawner.** Trail Boss does not launch, kill, or cost-optimize agents. It assumes
sessions already exist and surfaces the stuck ones.

---

## License

MIT
