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

## Phase 5: Presentation (PENDING)

## Phase 6: Walking Skeleton (PENDING)

## Phase 7: Iterate (PENDING)
