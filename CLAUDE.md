# Trail Boss

A tmux-based fleet supervision tool — a "dead-letter queue for AI coding agents." When Claude Code sessions stall (waiting for permission, or between turns), Trail Boss surfaces them in a priority queue so an operator can quickly attend to each one.

## Architecture

- **Daemon**: `daemon/` — Bun + SQLite HTTP server on `localhost:4000`. Receives hook events, maintains queue.
- **TUI**: `tui/` — Go + Bubble Tea terminal UI (Phase 8, being built). Replaces the bash `bin/trailboss-watch` script.
- **Scripts**: `bin/` — bash helpers (`trailboss-start`, `trailboss-bootstrap`, `trailboss-popup`, `trailboss-status`).
- **Hooks**: `.claude/trailboss-emit.sh` + `~/.claude/settings.json` — wire Claude Code hooks to the daemon.

## Tech Stack

- **Daemon**: Bun (TypeScript), SQLite via `bun:sqlite`
- **TUI (Phase 8)**: Go 1.24+, `charmbracelet/bubbletea`, `charmbracelet/bubbles`, `charmbracelet/lipgloss`
- **Bead prefix**: `tb`

## Closing Beads

When you complete a task, close the bead:
```
br batch --json '[{"op":"close","id":"<bead-id>"}]'
```

If closing fails with "Query returned no rows", that is a known `br close` bug — always use `br batch` instead.

## Phase 8 Context

The goal of Phase 8 is to replace the bash `bin/trailboss-watch` script with a proper Go + Bubble Tea TUI that:
- Shows a split layout: queue list (left ~40%) + detail pane (right ~60%)
- Color-codes reasons: `stopped` = yellow `#F1FA8C`, `permission` = red `#FF5555`
- Supports vim-style navigation: j/k, gg/G, ctrl+d/ctrl+u
- Polls `http://localhost:4000/queue` every 3s
- Jumps to sessions via `tmux switch-client`/`select-window`/`select-pane`

The TUI goes in `tui/` as a Go module (separate from the Bun daemon).

## Running the Daemon (for testing)

```bash
cd daemon && bun index.ts
```

## Key Files

- `daemon/index.ts` — HTTP server (ingest, queue, skip, next, status endpoints)
- `daemon/db.ts` — SQLite operations
- `daemon/reconcile.ts` — transcript reconcile loop
- `bin/trailboss-watch` — current bash dashboard (being replaced by tui/)
- `docs/plan/plan.md` — full design spec including Phase 8 TUI rewrite
- `PROGRESS.md` — implementation progress
