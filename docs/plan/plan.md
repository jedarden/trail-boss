# Trail Boss — design plan

The complete design: the problem, operating principles, the session/delivery model, the
architecture, what's been empirically confirmed, the phases, and the open questions. See
[`../research/claude-code-mechanics.md`](../research/claude-code-mechanics.md) for the Claude
Code primitives and [`../research/related-work.md`](../research/related-work.md) for prior art.

---

## Problem

You run long-form, human-in-the-loop agentic coding across many concurrent agent sessions,
one per tmux window. Each session periodically stalls waiting on **you**: a permission prompt,
a clarifying question, or a finished turn awaiting the next instruction. Today you find those
stalls by **manually cycling windows**. That polling is the bottleneck: most of your time goes
to *finding* the session that needs you, not *answering* it, and blocked sessions burn
wall-clock while otherwise-parallel work waits.

---

## Operating principles

### Human *on* the loop, not *in* it

Classic agentic HITL wires you into the inner cycle — approving each step, answering each
prompt — so you are the bottleneck on every iteration. Trail Boss flips it: agents run
autonomously by default and you supervise from above, **engaged only by exception**. When an
agent can't proceed on its own, it falls through to you.

**The human is the failure mode.** Trail Boss is a **dead-letter queue for a fleet of agents**:
the happy path never touches you; only stalled work routes to you, you process the exception
(reply or skip), and it goes back on the wire.

### The "stuck = needs attention" axiom — and stuck is stuck

A session that has stopped *or* is waiting at a permission prompt cannot progress toward its
goal until the human responds — therefore it needs intervention, by definition. This collapses
two fuzzy questions at once:

- **No "idle vs. done" distinction.** There is no separate "finished but fine" state; if it
  stopped and you haven't responded, it's waiting on you. Every stop is a queue item.
- **No "permission vs. stopped" distinction.** It doesn't matter *why* a session is stuck —
  both mean "blocked until the human acts." The two are detected by different hooks (see below)
  but are **treated identically** in the queue. `reason` is display-only metadata, never a
  priority input.

So the queue is a flat **dead-letter queue**: stuck sessions accumulate and the operator
depletes them. (The deeper fix — making the interactive CLIs longer-running so they stop less
often — is a separate workstream, not Trail Boss's concern.)

### Navigator, not relay

Trail Boss does **not** inject answers into sessions. It routes *your attention* to the live
session and you interact with the real CLI directly. It is an attention router + tmux
navigator, not an input relay or an autonomous responder. (Rationale and the rejected
alternatives are in [`../notes/decisions.md`](../notes/decisions.md).)

---

## Non-goals

- **Not a fleet spawner / supervisor.** Trail Boss does not launch, kill, or cost-optimize
  agents. It assumes sessions already exist and surfaces the stuck ones. (Spawning is the job
  of separate fleet tooling.)
- **Not an autonomous responder.** It never synthesizes or auto-sends a reply. It only routes
  you to a session; all input is human-authored, typed into the real CLI.
- **Not multi-operator / multi-tenant.** Single operator, single host, single tmux server.
- **Not a remote web product.** It is a same-host, tmux-native tool whose sole job is to
  eliminate manual tab-switching. Remote access is out of scope for v1.
- **Not dependent on plan mode.** Vanilla Claude Code plan mode is assumed disabled (the
  operator uses their own); the `reason` enum is exactly two values — **`permission`** and
  **`stopped`**.

---

## Session & delivery model

There are two mutually exclusive ways to run agent sessions; Trail Boss commits to one.

- **Model A — live panes (CHOSEN).** Long-running interactive CLIs stay resident in tmux
  panes. Delivery happens by *interacting with the live process* — Trail Boss navigates you to
  it. Survives disconnect via tmux (see Architecture).
- **Model B — transcript sessions (rejected for v1).** No resident process; a session exists
  only as its transcript, and a fresh `claude --resume <id>` is spawned per turn with Trail
  Boss rendering output itself.

**Why not Model B / resume-to-deliver:** a session's durable state is its transcript JSONL, but
a *live* interactive CLI holds its own in-memory copy and does not re-read that file for
outside changes. Running a second `claude --resume <id>` while the original is alive yields two
processes over one transcript: the resuming process produces the response *in itself*, the
original pane never reflects it, and concurrent writes risk divergence. The existence of
`--fork-session` ("create a new session ID instead of reusing the original") confirms plain
`--resume` reuses the session and is not designed for a concurrent second attach. So a reply
delivered via resume **does not** reach the original interactive pane. Model A + direct
interaction sidesteps this entirely.

---

## What is needed (capabilities)

1. **A blocked-state signal from every session** — Claude Code hooks (`Stop`,
   `PermissionRequest`), POSTing their stdin JSON to a local collector.
2. **A central collector + live state store** — tracks every session's status and holds the
   `session_id → pane` registry. The collector **is the daemon** (see Architecture); its HTTP
   ingest endpoint is one face of that single process. Presentation reads current state on
   demand (the `display-popup` *pulls*; there is no push/broadcast channel), so no WebSocket is
   required. An optional status-line "N stuck" segment, if added, polls the daemon.
3. **Context extraction** — *what* each session is asking. Largely free from the hook payload
   (see below); transcript tail for deeper/permission context.
4. **The Trail Boss queue** — a FIFO depletion surface (oldest-stuck first), keyboard-driven.
5. **Delivery by navigation** — route the operator to the live pane (tmux), no relay.

---

## Detection model

Two enqueue triggers, treated identically. **Both are required** — they catch *different*
stuck conditions: a session waiting at a permission prompt is mid-turn and does **not** emit
`Stop`, so without `PermissionRequest` it would never be detected. `Notification` is dropped.

| Hook | Why it's needed | Status |
|------|----------------------|--------|
| `Stop` | Turn finished; session waiting for the next instruction. | Confirmed firing in interactive and `-p` (probe 2026-05-25); payload carries `last_assistant_message` |
| `PermissionRequest` | Session blocked mid-turn on approval — emits **no** `Stop`, so this is the only signal for the permission case. | Exists; firing/payload **not yet probed** (phase 1) |
| `UserPromptSubmit` | Input submitted → session unstuck → **dequeue**. | Confirmed primitive |
| `SessionStart` | Register the session; re-assert `session_id → pane`. | Confirmed firing (probe) |
| `SessionEnd` | Retire the session. | Exists; firing not yet probed |
| ~~`Notification`~~ | Dropped — `Stop` + `PermissionRequest` cover every stuck case; the dead-letter queue just fills and drains. | Not used |
| ~~`SubagentStop`~~ | Ignored — a subagent finishing is not a human-input point. | Not used |

Both `Stop` and `PermissionRequest` enqueue a plain stuck item with no priority difference.

---

## Correlation & the self-healing registry

**Confirmed by probe (2026-05-25):** hook commands inherit the full ambient environment,
including `$TMUX_PANE`. So the `session_id → pane` mapping does not require a special hook — it
is rebuilt continuously.

- **Capture `$TMUX_PANE` on *every* emit** (not just `SessionStart`). Each event re-asserts
  `session_id → pane`, so the registry self-heals across resume, pane reuse, and window moves:
  a reused pane is corrected by the next event from its new session.
- Identity is available **both** as env vars and in the stdin payload (belt-and-suspenders):
  - env: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `TMUX_PANE`, `TMUX`,
    `CLAUDE_CODE_ENTRYPOINT` (`cli` interactive vs `sdk-cli` for `-p`), `CLAUDECODE=1`,
    `TERM_PROGRAM=tmux`, `CLAUDE_ENV_FILE` (per-session state dir).
  - payload: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus event-specific
    fields (below).
- Pane ids (`%446`) are **tmux-server-global** — addressable by any `tmux` command from outside
  tmux, which is what makes navigation-from-a-daemon possible.

---

## Context — what the session is asking

- **From the `Stop` payload directly (no transcript needed for the basic case):**
  `last_assistant_message` contains what the agent just said — render it straight in the queue
  card. Confirmed present in both modes. Stop also carries `permission_mode`, `effort`,
  `stop_hook_active`, `background_tasks`, `session_crons`.
- **From the transcript JSONL** (`transcript_path`, append-only, tailable): deeper context and,
  for `PermissionRequest`, the proposed tool/command. An enhancement, not a requirement.
- **From `tmux capture-pane -p <pane>`:** the literal on-screen prompt verbatim, as a fallback.

---

## Delivery — navigation via tmux (no relay)

In Model A you interact with the real CLI, so there is no fidelity/relay problem. tmux 3.5a on
the host provides every needed primitive (all confirmed present):
`switch-client`, `select-window`, `select-pane`, `link-window`/`unlink-window`,
`join-pane`/`break-pane`, `pipe-pane`, `capture-pane`, `display-popup`.

- **Minimal (recommended start):** route the operator's client to the head-of-queue
  (oldest-stuck) pane — `switch-client` + `select-window`/`select-pane %id`. This *is* "eliminate manual
  tab-switching," with zero relay.
- **Embedded (optional polish):** `link-window` the target session's window into a Trail Boss
  view so the queue and live pane are co-visible, then `unlink-window`. Non-destructive (tmux
  windows are shared objects). **Avoid `join-pane` as the primary** — it relocates the pane out
  of its home window and does not cleanly round-trip.
- **`send-keys`** remains available for plain text (basic submission confirmed working in the
  probe) but is a secondary path; native interaction is preferred.
- **Rejected:** `claude --remote-control` routes a session to the claude.ai / desktop / mobile
  surface, not a local control channel — useless for a same-host tool.

Because you interact with the real prompt, **"edit before allow" is native** — you just type in
the live pane. No special edit affordance or `canUseTool` round-trip is required in Model A.

---

## State & reliability

**The transcript JSONL is the ground truth; hooks are only the low-latency notification.**

- **Reconcile loop:** after a `Stop` for a session, watch its transcript; if new lines appear (a
  user message, a new assistant turn) it progressed → **dequeue**. A periodic sweep of all known
  transcripts rebuilds "is this session currently stopped?" purely from file state.
- This self-corrects **dropped hook POSTs** (hooks are fire-and-forget and must exit 0, so a
  POST to a down/slow collector is silently lost) and **collector restarts** (in-flight status
  is rebuilt from transcripts, not from missed transition events).
- It also handles **"you answered directly in the pane"** for free: a new user entry in the
  transcript → the item dequeues without a UI action.

---

## Architecture

```
   tmux server (host) ─ survives client disconnect
   ┌──────────────────────────────────────────────────────────┐
   │  agent pane 1 ─┐ Claude Code (hooks → curl localhost:4000) │
   │  agent pane 2 ─┤   Stop / PermissionRequest / SessionStart │
   │  agent pane N ─┘   (each emit carries $TMUX_PANE)          │
   │                          │                                 │
   │  ┌───────────────────────▼──────────────────┐             │
   │  │  Trail Boss daemon  (its own tmux window) │             │
   │  │  • ingest hooks, upsert state (SQLite)    │             │
   │  │  • session_id → pane registry (self-heal) │             │
   │  │  • transcript reconcile loop (ground truth)│            │
   │  │  • FIFO depletion queue (oldest-stuck 1st)│             │
   │  └───────────────────────┬──────────────────┘             │
   └──────────────────────────┼─────────────────────────────────┘
                              │ presentation (on reattach or keybinding)
                              ▼
           display-popup (queue overlay)  ──select──▶  switch-client /
           + optional status-line "N stuck"            select-window/pane
                                                        → you land on the
                                                          live head-of-queue pane
```

### Daemon vs. presentation split

- **Control plane — the daemon.** Always-on; ingests hooks, holds state, runs the reconcile
  loop, orders the queue FIFO, and issues `tmux` commands to navigate. It drives tmux "from outside" the agent
  panes — it does not need to occupy an agent pane to do so.
- **Presentation plane — transient & tmux-native.** A keybinding fires `tmux display-popup -E
  trailboss` to overlay the queue on your client; selecting an item runs `switch-client` +
  `select-window`/`select-pane` to drop you on the live pane. An optional status-line segment
  shows ambient "N stuck."

### Durability (the disconnect requirement)

Two things must survive an SSH disconnect:

1. **Agent sessions** — already durable: the tmux server is host-side; your terminal is just a
   client. Detach/drop leaves panes running; `tmux attach` restores them.
2. **The Trail Boss daemon** — a process started in your login shell would die on SIGHUP. So run
   it **in its own tmux window** (simplest; one server then holds agents *and* Trail Boss) or
   under **`systemd --user`** (if you also want it to survive host *reboots* — tmux does not).

**Backlog accumulation (a feature of this design):** because the daemon and the hook POSTs keep
running on the host while you're disconnected, the queue accumulates whatever got stuck in your
absence. On reattach, Trail Boss shows exactly what piled up — disconnecting becomes a
non-event instead of context loss.

---

## Layering: harness-coupled detection vs. harness-agnostic core

The most consequential open architecture question (and a deliberate seam): **at what layer does
Trail Boss operate?** The two halves want different answers.

- **Switching is already tmux-level and harness-agnostic.** Navigating to a stuck session is
  `switch-client`/`select-window`/`select-pane %id` — it works for *any* program in a pane,
  Claude Code or a future coding harness. Nothing about routing is Claude-specific.
- **Detection is currently Claude-Code-coupled.** The stuck/unstuck signal comes from Claude
  Code hooks (`Stop`, `PermissionRequest`, `UserPromptSubmit`). That is the reliable signal, but
  it binds detection to one harness.

To keep the door open for future harnesses without coupling the core, put detection behind an
**adapter interface**. The daemon consumes a normalized event — *"session S at pane P became
stuck / unstuck"* — and everything downstream (queue, FIFO depletion, navigation) is
harness-agnostic. Adapters produce that normalized event however they can:

- **Claude Code adapter (v1):** hooks → normalized event. Reliable, confirmed.
- **Future harness adapters:** their own hooks if they have them; else log/transcript tailing;
  else a tmux-level heuristic (e.g. pane output gone quiet at a prompt). Less reliable, but the
  core doesn't change.

**Decision for v1:** build the Claude Code adapter (hooks), but define the daemon's input as the
normalized stuck/unstuck event — *not* raw hook payloads — so the harness coupling stays
isolated to the adapter. The reliability of detection is the adapter's problem; switching is
always tmux. **Open:** the exact normalized event contract, and whether a purely tmux-level
detector (no hooks) is viable as a universal fallback.

---

## Queue & interaction loop (depletion)

The queue is a flat FIFO dead-letter queue, and the interaction model is **auto-advance
depletion**: you are always looking at one stuck session; when you finish with it, the next one
loads.

- **Membership:** every stuck session (from `Stop` or `PermissionRequest`). No priority between
  reasons; `reason` is display-only. Reconcile removes any that have progressed.
- **Order:** oldest-**ready**-stuck first (FIFO). The head of the queue is "the current
  session." An item whose skip-cooldown is still active is not eligible to be the head — the
  daemon advances to the next ready item; if none are ready, the queue presents as empty until a
  cooldown expires or a new event arrives.
- **Auto-advance (no forced focus-steal):** the operator works the *current* session in its
  live pane. When that session resolves — `UserPromptSubmit` fires (you responded) or you
  `skip` — the daemon **computes** the next head of queue, but the actual jump is
  **operator-initiated** (a keypress / re-invoking the popup), never an automatic
  `switch-client`. This matters because responding *is* what fires `UserPromptSubmit`: a forced
  jump would teleport you out of the pane the instant you hit Enter. So depletion is "resolve →
  next is ready → you press to advance," not a focus-steal. (Whether to offer an opt-in
  "auto-jump on resolve" toggle is deferred.)
- **Skip:** advances to the next without acting. The skipped session is **moved to the tail** of
  the FIFO (and stamped with a short re-surface cooldown) so depletion always progresses and a
  single item can't be re-selected immediately. In a one-item queue, skip lands you on empty;
  the item re-surfaces on its next event or after the cooldown.
- **Dequeue:** transcript advances past the last stuck point, or `UserPromptSubmit` fires, or
  `SessionEnd`.
- **Empty queue:** nothing stuck → no auto-advance; the operator is free. New stuck sessions
  re-arm the loop.

Saturation is a non-issue by construction: the queue can be arbitrarily long; the operator just
keeps depleting it, and the next-in-line always loads. There is no ceiling logic.

---

## Switching & keybindings

The operator drives the whole loop with a few **global tmux keybindings that call the daemon**.
A binding runs a `run-shell` command, which executes on the tmux server, so it can both query
the daemon's loopback endpoint *and* issue the navigation in one step. Three actions:

| Key (example) | Action | What it does |
|---------------|--------|--------------|
| `prefix + Tab` | **Next** | `trailboss jump-next` → `GET localhost:4000/next` returns the head-of-queue pane id → `tmux switch-client … \; select-window -t %ID \; select-pane -t %ID`. Lands you on the oldest-ready-stuck session. The primary action: *deal with current → press Next → land on the next stuck pane.* |
| `prefix + g` | **Popup / pick** | `display-popup -E 'trailboss popup'` renders the FIFO list (each item's reason + `last_assistant_message` snippet); arrow/number to choose; the popup exits and jumps you there. For triage or non-sequential jumps. |
| `prefix + s` | **Skip** | `trailboss skip` → daemon moves the current head to the tail + cooldown, then jumps to the new head (skip-and-advance in one press). |

Plus an ambient **status-line segment** (e.g. `⚠ 3 stuck`) so the operator knows when there's
anything to press Next for. The jump itself relies on pane ids being tmux-server-global:

```bash
# trailboss jump-next (essentials)
id=$(curl -s localhost:4000/next)        # daemon returns head-of-queue pane id, e.g. %446
[ -n "$id" ] && tmux switch-client -t "$(tmux display -p -t "$id" '#{session_name}')" \
                 \; select-window -t "$id" \; select-pane -t "$id"
```

Two constraints:

- **Use prefix bindings, not bare `Alt-`/`Ctrl-` keys.** A no-prefix binding would be globally
  stolen by tmux from the Claude Code TUI you're typing into, and could collide with the CLI's
  own keys. Prefix-based costs one extra keystroke but never interferes with session input.
- **The jump is the keypress — never automatic.** Replying *is* what fires `UserPromptSubmit`
  and dequeues the current session; an automatic jump would teleport you out of the pane the
  instant you hit Enter. Manual tmux navigation (`prefix + <n>`) is orthogonal — wandering off a
  pane the normal way does not change queue state; only a reply (`UserPromptSubmit`) or `skip`
  does.

This is the entire switching surface: one key cycles you through stuck sessions oldest-first, a
second shows the list to pick from, a third skips.

---

## Confirmed mechanics (empirical, 2026-05-25)

Probe: a `--settings`-loaded hook dumping env + stdin payload, run both via `claude -p` and a
driven interactive session in a throwaway tmux pane.

- **`$TMUX_PANE` is present in the hook environment** (`%445` / `%446`, matching the launch
  pane) — in *both* interactive (`CLAUDE_CODE_ENTRYPOINT=cli`) and headless (`sdk-cli`) modes.
  This is the load-bearing fact for the self-healing registry.
- **Both `SessionStart` and `Stop` fire**; interactive `Stop` fired ~4s after a human-prompted
  turn.
- **`Stop` payload includes `last_assistant_message`** → queue context for free.
- **Identity also exposed as env vars** (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`).
- **send-keys plain-text submission works** (typed prompt + `Enter` submitted cleanly).
- **tmux 3.5a** has all required commands; **`claude` 2.1.150** offers `-r/--resume`,
  `-c/--continue`, `--fork-session`, `--session-id`, `--settings`, `--remote-control`.

Still **unverified** (probe before depending on): `PermissionRequest` firing + payload shape
(esp. how the proposed command is represented and which gate types trigger it).

---

## Implementation phases

1. **Probe `PermissionRequest`** — confirm it fires for the gate types you hit and what its
   payload carries (the one remaining unknown). The `Stop`/`SessionStart`/`$TMUX_PANE` path is
   already confirmed.
2. **Emitter** — `trailboss-emit.sh` (carries `$TMUX_PANE` on every event) + the `settings.json`
   hook wiring.
3. **Daemon (control plane)** — ingest endpoint behind the normalized stuck/unstuck adapter
   contract, SQLite state, self-healing registry, the transcript reconcile loop, FIFO queue.
   Runs in its own tmux window.
4. **Navigation** — `switch-client`/`select-window`/`select-pane` to route to a pane by id;
   compute the next head on resolve/skip and jump on operator action (no forced focus-steal).
5. **Presentation** — `display-popup` queue overlay + keybinding; optional status-line segment.
6. **Close the loop (walking skeleton)** — stuck pane → loaded into focus → interact → reconcile
   dequeues it → next stuck session auto-loads. This end-to-end depletion path is the first
   milestone.
7. Iterate: auto-advance trigger tuning, skip/re-surface behavior, embedded `link-window` view,
   and a second harness adapter to validate the abstraction.

---

## Testing & validation

This system is almost entirely process and tmux side-effects, so "it compiles" proves nothing.
Each phase has an observable **exit criterion** (its definition of done), the walking skeleton
has **acceptance scenarios** that must pass end-to-end, and there is a **test harness** that
exercises behavior without burning model quota.

### Per-phase exit criteria (definition of done)

| Phase | Done when (observable) |
|-------|------------------------|
| 1. Probe `PermissionRequest` | A captured `PermissionRequest` payload is recorded in `docs/research/claude-code-mechanics.md`, showing the field that carries the proposed tool/command, confirmed for the gate types in use (a bash command, a file edit). Confirmed that a permission block fires `PermissionRequest` and **no** `Stop`. |
| 2. Emitter | With the hooks wired, a real session that stops / hits a permission / submits input causes a stub collector to log POSTs whose body carries `session_id`, `cwd`, **and** `$TMUX_PANE`. A bare-`curl` control (no emit script) is shown to drop `$TMUX_PANE` — proving the wrapper is required. |
| 3. Daemon | Synthetic events POSTed to the loopback endpoint produce correct state: a session enters the queue on `Stop`/`PermissionRequest` and leaves on `UserPromptSubmit`; a second event with a new pane updates the registry (self-heal); the reconcile loop dequeues a session whose transcript advanced past its last stuck point; `GET /next` returns the oldest-ready pane id; state survives a daemon restart (rebuilt from transcripts). |
| 4. Navigation | `trailboss jump-next` lands the operator's tmux client on the pane id returned by `/next` — verified by asserting `tmux display -p '#{pane_id}'` equals the target after the jump. |
| 5. Presentation | The Next and Skip keybindings and the `display-popup` picker work: Next jumps to the head-of-queue pane; the popup lists the queue with `reason` + `last_assistant_message` snippet; the status-line shows the correct stuck count. |
| 6. Walking skeleton | Acceptance scenarios AS-1 … AS-6 below all pass end-to-end. |
| 7. Iterate | Each enhancement ships with its own added acceptance scenario (e.g., the embedded `link-window` view, the second harness adapter). |

### Acceptance scenarios (the walking skeleton must pass all)

- **AS-1 — single permission block:** a session runs a tool needing approval → within a few
  seconds it appears in the queue with `reason=permission` and the proposed command visible →
  Next lands the operator on that pane → approving fires `UserPromptSubmit` → reconcile
  dequeues it → queue empty.
- **AS-2 — FIFO ordering:** session A stops, then session B stops a minute later → the queue
  head is A (oldest) → resolving A and pressing Next lands on B.
- **AS-3 — answered-in-pane (reconcile):** a stopped session is queued; the operator answers it
  *directly in its pane* (not via Trail Boss) → the new transcript entry causes reconcile to
  dequeue it with no UI action.
- **AS-4 — dropped-event recovery:** the collector is down when a `Stop` fires (POST lost); on
  restart, the reconcile sweep rebuilds the queue from transcripts and the session appears.
- **AS-5 — skip + cooldown:** queue = [A, B]; Skip on A lands on B and moves A to the tail with
  a cooldown; while the cooldown is active and B is resolved, the queue presents as **empty**
  (A is not eligible as head) until the cooldown expires, then A reappears.
- **AS-6 — no forced focus-steal:** while the operator is typing in some pane that is *not* the
  queue head, a session resolving does **not** auto-switch their client; the jump happens only
  on a Next/Skip keypress.
- **AS-7 — pane reuse (regression):** a session ends and its pane is reused by a new session;
  the new session's first event re-asserts `session_id → pane`, and navigation targets the
  current pane, never the retired one.

### Test harness & approach

- **Throwaway tmux isolation:** all behavioral tests spawn uniquely-named tmux sessions in a
  temp dir / `~/scratch`, assert via `capture-pane`, collector logs, or SQLite, and tear down.
  Never touch panes the test doesn't own; never `send-keys` into foreign sessions.
- **Synthetic event injection (unit-level, no quota):** POST hand-crafted hook payloads to the
  daemon's loopback endpoint to drive queue/registry/reconcile logic deterministically without
  a live agent. This is the primary way to test phases 3–5 fast.
- **Transcript fixtures:** feed canned JSONL transcripts to the reconcile loop to assert the
  dequeue decision (advanced-past-stuck → drop).
- **Mock hook emitter:** a tiny script that fires `Stop`/`PermissionRequest` with a chosen
  `session_id` + `$TMUX_PANE`, so the daemon and navigation can be exercised end-to-end without
  invoking a model.
- **Navigation assertion:** create panes with known ids, run `jump-next`, assert the active
  pane id — pure tmux, no model.
- **Invariant checks (must always hold):** assert the daemon never issues `send-keys` of
  non-human-authored content (grep the dispatch path / test that no code path synthesizes
  input), and that the ingest socket binds loopback only.

### Quality gate

A phase is not "done" until its exit-criterion row passes. Phase 6 is not "done" until AS-1
through AS-6 pass. The marathon must treat these as the **definition of done** — do not mark a
phase complete on code-read alone; run the scenario and observe it.

---

## Failure modes & invariants

**Invariants**
- *Human-authored only:* the daemon never sends synthesized input to a session.
- *The queue never lies:* a displayed item reflects current transcript state (reconcile is
  authoritative over hook events).

**Trust boundary**
- The collector/daemon binds its ingest endpoint to **loopback only** (`127.0.0.1:4000`) — it is
  never exposed off-host. Per the single-operator/single-host non-goal, **all local processes are
  trusted**: hook POSTs are unauthenticated and the `session_id` / `$TMUX_PANE` they carry are
  taken on trust.
- This is acceptable on a single-user host. On a **multi-user host** it is not: any local process
  could POST a forged event with an attacker-chosen `$TMUX_PANE`, causing the daemon to navigate
  the operator to — or, if the optional `send-keys` path is enabled, type into — an arbitrary
  pane. Mitigations if that ever matters: a unix-domain socket with file-mode restrictions, or a
  shared secret in the hook POSTs.
- The optional `send-keys` delivery path is the only way a forged event could inject
  *keystrokes*; with it disabled (navigation-only, the default), a forged event can at worst
  mis-route the operator's focus — annoying, not destructive.

**Failure modes**
- *Hook POST dropped (collector down/slow):* hook exits 0, event lost → reconcile sweep
  recovers it from transcripts.
- *Daemon restart:* SQLite persists rows; current blocked-status is rebuilt from transcripts.
- *Pane reused / session resumed:* next event re-asserts `session_id → pane`; navigation always
  targets the pane in the latest event.
- *Host reboot:* tmux server (and thus everything) is lost. **v1: the operator re-invokes Trail
  Boss and relaunches sessions manually after a restart** — no auto-resurrection.
- *Stale navigation target:* worst case you land on a pane that already moved on; reconcile
  would have dequeued it, so the popup shouldn't have offered it — acceptable, non-destructive.

---

## Open questions

**Open**

1. **Harness layering / adapter contract** *(the main one)* — define the normalized
   stuck/unstuck event the daemon consumes, so detection stays isolated to a per-harness
   adapter. Is a purely tmux-level detector (no hooks) viable as a universal fallback for future
   harnesses? See "Layering" above.
2. **`PermissionRequest` specifics** — confirm it fires for the gate types you hit and what its
   payload carries (the proposed command, for display). Detection coverage depends on it; phase 1.
3. **Auto-advance residual** — the trigger, jump model, and keybindings are specified (see
   "Switching & keybindings": Next/Popup/Skip keys, operator-initiated jump, manual tmux nav is
   orthogonal). The only residual is whether to offer an opt-in "auto-jump on resolve" toggle —
   decide after the walking skeleton.
4. **Presentation polish** — the mechanism is specified (`display-popup` picker + Next/Skip
   keybindings + status-line segment). Residual polish: exact key choices, popup layout/columns,
   and whether a dedicated always-visible window is worth adding alongside the popup. Tune after
   the walking skeleton.

**Resolved this round (recorded so they don't get re-litigated)**

- *Permission vs. stopped priority* → none. Stuck is stuck; `reason` is display-only, queue is
  FIFO.
- *`Notification`* → dropped; `Stop` + `PermissionRequest` cover every stuck case.
- *Multiple tmux clients* → not a real scenario; one active focus, auto-advanced through the
  queue (single-operator non-goal).
- *Reboot durability* → out; operator re-invokes after restart.
- *Concurrency ceiling* → non-issue; the depletion loop just loads the next one, no ceiling
  logic.
