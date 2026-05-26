# Trail Boss — Marathon Coding Instruction

You are an autonomous developer implementing **Trail Boss**. Each iteration you read this
file, do **one coherent unit of work** toward the plan, verify it, commit, push, and the loop
restarts you fresh. Work is driven by `docs/plan/plan.md` (the authoritative design).

## Project overview

Trail Boss is a single-pane attention router for interactive AI coding-agent sessions
(Claude Code, running in tmux panes). When a session blocks waiting on the human — a
permission prompt, or a finished turn awaiting the next instruction — Trail Boss surfaces it
in a flat FIFO dead-letter queue and **navigates the operator to the live tmux pane** to act.
It never injects input ("navigator, not relay"). The human is on the loop, engaged only by
exception.

## Working directory

This repository (the marathon runs with its CWD set to the repo root). Use **relative paths**.

## Authoritative docs — read the relevant parts before coding

- `docs/plan/plan.md` — the complete design: capabilities, detection model, architecture,
  the daemon/presentation split, the switching & keybindings surface, phases, open questions.
- `docs/research/claude-code-mechanics.md` — the Claude Code hook/env/payload facts
  (probe-confirmed): `$TMUX_PANE` is in the hook env; the single `trailboss-emit.sh`;
  `Stop` + `PermissionRequest` are the two enqueue triggers.
- `docs/notes/decisions.md` — settled decisions. **Do not re-litigate these** (navigator-not-
  relay, flat FIFO/no-priority, Notification dropped, collector-is-the-daemon, etc.).

## Current state

Phases 1–5 are **complete**. Phase 6 (Walking Skeleton) is next.

- Phase 1 (Probe): done — findings in `docs/research/claude-code-mechanics.md`
- Phase 2 (Emitter): done — `.claude/trailboss-emit.sh` + `.claude/settings.json`
- Phase 3 (Daemon): done — `daemon/` (Bun + SQLite), `package.json`
- Phase 4 (Navigation): done — `bin/trailboss` (jump-next, skip)
- Phase 5 (Presentation): done — `bin/trailboss-popup`, `bin/trailboss-status`, `tmux.conf`

Read `PROGRESS.md` for per-phase details and the current next action.

## Iteration protocol

Each iteration:

1. **Orient** — read `PROGRESS.md` (if present) to see what's done and what's next. Skim the
   relevant section of `docs/plan/plan.md`.
2. **Pick one unit** — the next unblocked item in the phase order below. Don't skip ahead;
   foundational work first. Stay focused on a single coherent change.
3. **Implement** — write the code/scripts. Follow the settled design in the docs; if you make
   a new design decision, record it in `docs/notes/decisions.md`.
4. **Verify against the definition of done** — a phase is done only when its **exit criterion**
   in `docs/plan/plan.md` → "Testing & validation" is observably true (Phase 6 requires
   acceptance scenarios AS-1…AS-6 to pass). Actually exercise what you built (run the script,
   hit the endpoint, fire the hook) using the test harness described there — synthetic event
   injection for daemon/queue logic, throwaway tmux sessions under `~/scratch` for hook/tmux
   behavior. Don't mark anything done on code-read alone. Never disturb tmux sessions you don't
   own, and never `send-keys` into panes you don't own.
5. **Commit + push** — mandatory every iteration: `git add` the specific files, commit with a
   conventional message (`feat(scope): …`, `fix(scope): …`, `docs(scope): …`), then
   `git push origin main`. Origin mirrors to GitHub automatically.
6. **Update `PROGRESS.md`** — what you did, what's next, any new known issues.

If a phase's work is genuinely blocked, write down why in `PROGRESS.md` and pick the next
most-impactful unblocked unit.

## Phase order (see `docs/plan/plan.md` "Implementation phases" for detail)

1. **Probe `PermissionRequest`** — confirm it fires for the gate types in use and capture its
   payload shape (the one remaining unknown). `Stop`/`SessionStart`/`$TMUX_PANE` are already
   probe-confirmed. Record findings in `docs/research/claude-code-mechanics.md`.
2. **Emitter** — `trailboss-emit.sh`: forwards the hook stdin payload to the collector and
   injects `$TMUX_PANE`. Plus the `settings.json` hook wiring (all hooks → this one script).
3. **Daemon (control plane)** — ingest endpoint (loopback only), SQLite state, the self-healing
   `session_id → pane` registry, the transcript reconcile loop, and the FIFO queue. Expose
   `/next` and `/skip`. Behind the normalized stuck/unstuck adapter contract so detection stays
   harness-agnostic. Default stack: fork disler's hook event store (Bun + SQLite) unless a
   better fit emerges — record the choice in `docs/notes/decisions.md`.
4. **Navigation** — resolve a pane id to `switch-client`/`select-window`/`select-pane`;
   compute the next head on resolve/skip (operator-initiated jump, no forced focus-steal).
5. **Presentation** — `display-popup` queue picker + the Next/Skip keybindings + an optional
   status-line "N stuck" segment.
6. **Walking skeleton** — close the loop end-to-end: stuck pane → loaded into focus → interact
   → reconcile dequeues → next stuck session loads. This is the first real milestone.
7. **Iterate** — auto-jump toggle, skip/cooldown tuning, embedded `link-window` view, a second
   harness adapter to validate the abstraction.

## Settled invariants (enforce; do not violate)

- **Navigator, not relay.** Never send synthesized input into a session. Delivery is
  navigation to the live pane; any `send-keys` is human-authored text only and secondary.
- **The queue never lies.** The transcript JSONL is ground truth; reconcile is authoritative
  over hook events.
- **Flat FIFO, no priority.** `permission` and `stopped` are treated identically; `reason` is
  display-only.
- **Loopback-only ingest.** The collector binds `127.0.0.1` only.

## Git workflow

- All work goes to `main` (no feature branches for marathon work).
- Commit + push every iteration. Conventional commit messages.
- **Never force-push; never amend published commits.**

## Constraints

- Don't run a TUI inside this agent's own terminal — test TUIs in a separate tmux session.
- Keep the repo **public-clean**: no internal infrastructure hostnames, cluster names, tokens,
  or absolute home paths in committed files. Use relative paths and env/config indirection.
- Don't add dependencies or abstractions the current phase doesn't need.
