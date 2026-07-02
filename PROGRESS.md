# Trail Boss — Marathon Progress

## Phase 1: Probe `PermissionRequest` ✅ COMPLETE

**Done:** Confirmed `PermissionRequest` fires for gate types and captured payload shape.

**Findings documented in `docs/research/claude-code-mechanics.md`:**
- `PermissionRequest` fires when a tool requires permission (tested with `Edit`)
- Payload includes `tool_name` + `tool_input` — exactly what the queue needs to display the proposed operation
- `$TMUX_PANE` is available in hook environment (confirmed via `%461` in probe)
- `permission_mode`, `session_id`, `transcript_path`, `cwd` all present
- Permission block emits `PermissionRequest` and **no** `Stop` (confirmed)

## Phase 2: Emitter ✅ COMPLETE

**Done:** Built `trailboss-emit.sh` that forwards hook payloads to collector and injects `$TMUX_PANE`. Wired all hooks in `.claude/settings.json`.

**Verified:** Stub collector logged POSTs with `session_id`, `cwd`, and `pane_id`. Demonstrated bare curl drops `$TMUX_PANE` — proving the wrapper is required.

**Files:**
- `.claude/trailboss-emit.sh` — emitter script
- `.claude/settings.json` — hook wiring

## Phase 3: Daemon (IN PROGRESS)

**Goal:** Build the daemon with ingest endpoint, SQLite state, self-healing registry, transcript reconcile loop, and FIFO queue.

**Done:**
- Chose Bun + SQLite stack
- Designed normalized stuck/unstuck adapter contract (claude-adapter.ts)
- Implemented ingest endpoint on loopback only (127.0.0.1:4000/event)
- Implemented SQLite state with session_id → pane registry
- Implemented transcript reconcile loop (runs every 5s)
- Implemented FIFO queue with /next and /skip endpoints
- Added /status and /queue endpoints for health and listing

**Verified via synthetic event testing:**
- Sessions enter queue on Stop/PermissionRequest and leave on UserPromptSubmit
- Second event with new pane updates registry (self-heal)
- Reconcile loop dequeues sessions whose transcript advanced
- GET /next returns oldest-ready pane id (respects skip cooldown)
- State survives daemon restart

**Files:**
- `daemon/index.ts` — main HTTP server
- `daemon/types.ts` — normalized event types
- `daemon/claude-adapter.ts` — Claude Code hook adapter
- `daemon/db.ts` — SQLite state layer
- `daemon/reconcile.ts` — transcript reconcile loop
- `daemon/schema.sql` — database schema
- `package.json` — dependencies
- `test-daemon.sh` — basic synthetic event tests
- `test-daemon-phase3.sh` — Phase 3 exit criteria tests

**Tech stack decision:** Bun + SQLite
- Fast startup, low memory footprint
- Built-in SQLite support (no native module compilation)
- Modern TypeScript/JavaScript ecosystem
- Single-file deployment easy

**Next:**
- Phase 4: Navigation — implement trailboss jump-next that switches to the pane

## Phase 4: Navigation ✅ COMPLETE

**Done:** Implemented `trailboss` CLI with `jump-next` and `skip` commands.

**Verified:**
- `jump-next` queries `/next` and navigates via `switch-client`/`select-window`/`select-pane`
- `skip` posts `/skip` then jumps to new head
- Exit criterion passed: navigation lands operator on pane returned by `/next`

**Files:**
- `bin/trailboss` — main CLI (jump-next, skip, popup stub)
- `test-navigation.sh` — synthetic event test verifying navigation

**Next:**
- Phase 5: Presentation — tmux keybindings, display-popup queue picker, status-line segment

## Phase 5: Presentation ✅ COMPLETE

**Done:** Implemented presentation layer — popup queue picker, keybindings, and status-line segment.

**Verified:**
- `trailboss popup` displays FIFO list with index-based selection
- Keybindings configured (prefix+Tab for Next, prefix+s for Skip, prefix+g for Popup)
- Status-line segment shows "⚠ N" when stuck sessions exist
- Exit criterion passed: all presentation components work

**Files:**
- `bin/trailboss-popup` — queue picker with python3 JSON parsing, box drawing UI
- `bin/trailboss-status` — status-line segment showing stuck count
- `tmux.conf` — keybindings for Next/Skip/Popup

**Next:**
- Phase 6: Walking Skeleton — end-to-end acceptance scenarios (AS-1 through AS-7)

## Phase 6: Walking Skeleton ✅ COMPLETE

**Done:** All 7 acceptance scenarios pass end-to-end.

**Verified:**
- `test-walking-skeleton.sh` passes all scenarios (AS-1 through AS-7)
- AS-1: Single permission block — enqueue, navigate, approve, dequeue
- AS-2: FIFO ordering — session A before B, depletes oldest-first
- AS-3: Answered-in-pane reconcile — transcript advance dequeues without UI action
- AS-4: Dropped-event recovery — collector down during Stop, reconcile rebuilds queue
- AS-5: Skip + cooldown — skip moves to tail, cooldown makes queue empty until expiry
- AS-6: No forced focus-steal — resolving a session does NOT auto-switch client
- AS-7: Pane reuse regression — new session in old pane: navigation targets current owner

**Files:**
- `test-walking-skeleton.sh` — comprehensive acceptance scenario test suite (399 lines)
- `notes/tb-4mq.md` — phase 6 completion notes

**Next:**
- Phase 7: Iterate — polish, edge cases, and enhancement loop

## Phase 7: Iterate (IN PROGRESS)

**Done:**
- Dashboard labels: `trailboss-watch` now resolves pane_id → tmux session name (alpha, bravo, etc.) via a single `tmux list-panes -a` call per render, falling back to CWD last component
- Fixed `prefix+s` conflict with tmux's built-in session chooser → moved skip to `prefix+S`
- `trailboss-start` auto-creates the `trail-boss` tmux session if it doesn't exist
- Confirmed real hooks firing and dequeuing bootstrap entries correctly (ended/unstuck events in daemon log)

**Verified working end-to-end:**
- Daemon running in `trail-boss:daemon` window (stable, survives shell exits)
- Dashboard showing NATO session names (alpha → mike) + telegram-bridge panes
- Real Claude Code hooks (Stop, UserPromptSubmit) dequeuing sessions as they become active

## Phase 9: Supervisor Split View ✅ COMPLETE

**Done:** `trail-boss:dashboard` is now a 2-pane split — TUI on top (60%), live preview on bottom (40%).

**Implemented:**
- `bin/trailboss-preview` — bash loop: reads `/tmp/trailboss-preview-target`, renders `tmux capture-pane` output every 0.5s
- `tui/client.go` — `WritePreviewTarget()` writes selected pane_id to target file
- `tui/model.go` — `syncPreview()` called on every cursor movement + queue update
- `bin/trailboss-start` — kill-session + fresh session; uses stable window ID (`@NNN`) + pane ID (`%NNN`) to avoid pane-base-index and auto-rename pitfalls; passes command directly to `split-window` (no send-keys race)
- `tmux.conf` — `prefix+B` always returns to `trail-boss:dashboard`
- `bin/trailboss` — `return` command targets `trail-boss:dashboard`

## Phase 8: TUI Rewrite ✅ COMPLETE

**Done:** Replaced bash-based `trailboss-watch`/`trailboss-popup` with a proper Go + Bubble Tea TUI.

**Implemented:**
- `tui/client.go` — HTTP client for daemon, tmux pane map, JumpToPane with origin tracking
- `tui/theme.go` — Dracula palette Lipgloss styles with dumb-terminal fallback
- `tui/model.go` — Full Bubble Tea model: split layout, vim keys, auto-refresh, help overlay
- `tui/main.go` — Entry point with AltScreen + mouse support
- `bin/trailboss-tui` — Pre-built binary (10MB, Go 1.24.2)
- `bin/trailboss-start` — Updated to `exec "$TB_DIR/bin/trailboss-tui"`

**Features:**
- Split layout: list (40%) + detail (60%) for width≥100, list-only for narrow terminals
- Color: stopped=yellow `#F1FA8C`, permission=red `#FF5555`, selected=purple `#BD93F9`
- Keys: j/k, gg/G, ctrl+d/ctrl+u, Enter (jump), l/Tab (detail focus), s (skip), r (refresh), J/K (detail scroll), 1-9 (direct jump), ? (help), q (quit)
- Auto-refresh every 3s; graceful daemon-unreachable display in status bar
- Detail pane: word-wrapped last_message, CWD, relative stuck time
- Help overlay centered with rounded border
