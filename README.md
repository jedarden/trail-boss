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

## Components

| Component | Language | Purpose |
|-----------|----------|---------|
| `daemon/` | TypeScript (Bun) | HTTP event ingestion, SQLite state, queue API |
| `tui/` | Go (Bubble Tea) | Split-panel TUI dashboard |
| `bin/trailboss` | Shell | CLI: `jump-next`, `skip`, `popup`, `return` |
| `bin/trailboss-tui` | Go binary | Pre-built TUI binary |
| `bin/trailboss-start` | Shell | Launches daemon + TUI in a `trail-boss` tmux session |
| `bin/trailboss-preview` | Shell | Live pane capture loop for the split-view preview |
| `bin/trailboss-status` | Shell | tmux status-bar segment showing stuck count |
| `.claude/trailboss-emit.sh` | Shell | Hook emitter wired into Claude Code settings |

---

## Requirements

- [Bun](https://bun.sh) — daemon runtime
- tmux
- Claude Code with hooks enabled
- Go 1.24+ — only needed to rebuild the TUI from source (a pre-built binary is in `bin/`)

---

## Setup

### 1. Install daemon dependencies

```bash
cd /path/to/trail-boss
bun install
```

### 2. Wire Claude Code hooks

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
│   └── types.ts          # Shared types
├── tui/
│   ├── main.go           # Entry point (AltScreen + mouse)
│   ├── model.go          # Bubble Tea model + split layout
│   ├── client.go         # Daemon HTTP client + tmux navigation
│   └── theme.go          # Dracula palette + dumb-terminal fallback
├── bin/
│   ├── trailboss         # CLI: jump-next, skip, popup, return
│   ├── trailboss-tui     # Pre-built TUI binary (Go 1.24)
│   ├── trailboss-start   # Session launcher
│   ├── trailboss-popup   # Queue picker popup (box-drawing UI)
│   ├── trailboss-preview # Live pane capture loop
│   └── trailboss-status  # tmux status segment
├── docs/
│   └── plan/plan.md      # Complete design spec
├── .claude/
│   └── trailboss-emit.sh # Hook emitter
└── tmux.conf             # Keybinding configuration
```

---

## Status

Phases 1–9 complete. All 7 acceptance scenarios pass end-to-end.

**What works:**
- Hook detection: `Stop` and `PermissionRequest` enqueue; `UserPromptSubmit` dequeues
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
