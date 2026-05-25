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

### The "stopped = needs attention" axiom

A session that has stopped cannot progress toward its goal — therefore it needs intervention,
by definition. This collapses the fuzzy "idle vs. done" question: **every `Stop` is a real
queue item.** There is no separate "finished but fine" state to detect; if it stopped and you
haven't responded, it's waiting on you. (The deeper fix — making the interactive CLIs
longer-running so they stop less often — is a separate workstream, not Trail Boss's concern.)

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
  operator uses their own); `reason` collapses to **permission** and **stopped/needs-next**.

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
2. **A central collector + live state store** — tracks every session's status, holds the
   `session_id → pane` registry, broadcasts the queue.
3. **Context extraction** — *what* each session is asking. Largely free from the hook payload
   (see below); transcript tail for deeper/permission context.
4. **The Trail Boss queue** — a prioritized, keyboard-driven surface, most-stuck-first.
5. **Delivery by navigation** — route the operator to the live pane (tmux), no relay.

---

## Detection model

`Stop` and `PermissionRequest` are the two load-bearing signals; `Notification` is optional.

| Hook | Meaning for the queue | Status |
|------|----------------------|--------|
| `Stop` | Turn finished; session waiting. **A queue item, always** (per the axiom). Payload carries `last_assistant_message`. | Confirmed firing in both interactive and `-p` (probe 2026-05-25) |
| `PermissionRequest` | Hard block: a tool wants approval. | Exists; firing/payload **not yet probed** |
| `Notification` | Attention nudge (long idle, etc.). Supplementary; drop if it adds nothing. | Optional |
| `UserPromptSubmit` | Input submitted → block resolved → **dequeue**. | Confirmed primitive |
| `SessionStart` / `SessionEnd` | Register / retire the session. | Confirmed firing (probe) |

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

- **Minimal (recommended start):** route the operator's client to the most-stuck pane —
  `switch-client` + `select-window`/`select-pane %id`. This *is* "eliminate manual
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
   │  │  • rank: permission > stopped, oldest-first│            │
   │  └───────────────────────┬──────────────────┘             │
   └──────────────────────────┼─────────────────────────────────┘
                              │ presentation (on reattach or keybinding)
                              ▼
           display-popup (queue overlay)  ──select──▶  switch-client /
           + optional status-line "N stuck"            select-window/pane
                                                        → you land on the
                                                          live most-stuck pane
```

### Daemon vs. presentation split

- **Control plane — the daemon.** Always-on; ingests hooks, holds state, runs the reconcile
  loop, ranks, and issues `tmux` commands to navigate. It drives tmux "from outside" the agent
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

## Queue & ranking

- **Membership:** every session in `BLOCKED` (reason `permission` or `stopped`). Reconcile
  removes any that have progressed.
- **Ranking:** `permission` (time-sensitive, stalling real progress) ranks above `stopped`
  (the operator owes it the next instruction but nothing is mid-flight); within a tier, oldest
  first.
- **Skip:** advances the cursor without acting; the item stays and re-surfaces (optional small
  penalty so a just-skipped item doesn't bounce straight back to the top).
- **Dequeue:** transcript shows progress, or `UserPromptSubmit` fires, or `SessionEnd`.

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
3. **Daemon (control plane)** — ingest endpoint, SQLite state, self-healing registry, the
   transcript reconcile loop, ranking. Runs in its own tmux window.
4. **Navigation** — `switch-client`/`select-window`/`select-pane` to route to a pane by id.
5. **Presentation** — `display-popup` queue overlay + keybinding; optional status-line segment.
6. **Close the loop (walking skeleton)** — stuck pane → appears in popup → select → land on the
   live pane → interact → reconcile dequeues it. This end-to-end path is the first milestone.
7. Iterate: ranking policy, skip penalty, embedded `link-window` view, reboot-durable systemd
   unit.

---

## Failure modes & invariants

**Invariants**
- *Human-authored only:* the daemon never sends synthesized input to a session.
- *The queue never lies:* a displayed item reflects current transcript state (reconcile is
  authoritative over hook events).

**Failure modes**
- *Hook POST dropped (collector down/slow):* hook exits 0, event lost → reconcile sweep
  recovers it from transcripts.
- *Daemon restart:* SQLite persists rows; current blocked-status is rebuilt from transcripts.
- *Pane reused / session resumed:* next event re-asserts `session_id → pane`; navigation always
  targets the pane in the latest event.
- *Host reboot:* tmux server (and thus everything) is lost unless the daemon is a `systemd`
  unit and agents are relaunched — out of scope for v1, noted for later.
- *Stale navigation target:* worst case you land on a pane that already moved on; reconcile
  would have dequeued it, so the popup shouldn't have offered it — acceptable, non-destructive.

---

## Open questions

1. **`PermissionRequest` specifics** — firing conditions across gate types and payload shape
   (the proposed command/tool). The last real unknown; phase 1.
2. **`Notification` value-add** — does it surface anything `Stop` + `PermissionRequest` miss? If
   not, drop it.
3. **Multi-client targeting** — if more than one tmux client is attached, which does
   `switch-client`/`display-popup` target? Pick the active one; confirm behavior.
4. **Popup UX** — does a `display-popup` queue + jump feel fast enough, or is a dedicated
   always-visible window better? Decide after the walking skeleton.
5. **Permission rendering** — for a `permission` item, how much of the proposed command to show
   in the popup (transcript tail vs. payload) before you jump to the pane.
6. **Reboot durability** — `systemd --user` for the daemon + an agent-relaunch story, if/when
   reboot-survival matters.
7. **Concurrency ceiling** — at what session count does the operator saturate regardless of
   routing? The router buys throughput, not infinite capacity.
