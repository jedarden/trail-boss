# Trail Boss

**You run a herd of AI coding agents like cattle, each grazing its own task. When one bogs
down or strays — needs a decision, hits a permission gate, or finishes and waits for the next
order — Trail Boss is the single pane where it reports in. You ride over, set it right (or
wave it on), and your reply lands back in the exact session — so you stop hand-cycling
terminal windows hunting for whoever's stuck.**

## Human *on* the loop, not *in* it

Trail Boss turns human-**in**-the-loop into human-**on**-the-loop. Classic agentic HITL wires
you into the inner cycle — approving each step, answering each prompt — so you are the
bottleneck on every iteration. Trail Boss flips it: agents run autonomously by default and you
supervise from above, engaged only by **exception**. When an agent can't proceed on its own —
needs a decision, hits a permission gate, or exhausts its turn — it falls through to you.

Put plainly, **the human is the failure mode.** Trail Boss is a **dead-letter queue for a fleet
of agents**: the happy path never touches you; only stalled work routes to you, you process the
exception (reply or skip), and it goes back on the wire. Instead of *you* polling many sessions
to find the one that needs you, each stuck session raises its hand and Trail Boss presents them
as one **prioritized queue — most-stuck first**. Read the context, give the order (reply), or
wave it on (skip).

```
┌─ TRAIL BOSS ────────────────────────────────────────────── 3 stuck ───┐
│                                                                        │
│  ▶ api-gateway         PERMISSION   stuck 2m14s                        │
│      wants to run: terraform apply -target=module.lb                   │
│      [a]llow  [d]eny  [e]dit  [s]kip  [o]pen pane                       │
│  ──────────────────────────────────────────────────────────────────  │
│    search-index        PLAN         stuck 0m48s                        │
│      proposed plan: "Add incremental reindex on write…" (42 ln)        │
│  ──────────────────────────────────────────────────────────────────  │
│    docs-site           QUESTION     stuck 0m11s                        │
│      "Version the API reference per release, or keep one rolling page?"│
│                                                                        │
│  [tab] next   [enter] focus   reply ▸ ____________________________     │
└────────────────────────────────────────────────────────────────────────┘
```

## Why

Long-form agentic coding runs many sessions in parallel, one per terminal window. Each
periodically stalls waiting on a human:

- a permission prompt (run this command? edit this file?)
- a plan waiting for approval
- a clarifying question
- or it simply finished its turn and is idle, wanting the next instruction

Discovering those stalls by manually cycling windows is the bottleneck — with N sessions,
most of your time goes to *finding* the one that needs you, not *answering* it, and a session
can sit blocked for minutes while otherwise-parallel work waits. The human is the scarce
resource; the system should route the human's attention, not the other way around — engaging
you by exception, not on every step.

## How it works

Each agent session emits a signal the moment it blocks, via **Claude Code hooks** — `Stop`
(turn finished, idle, awaiting the next prompt) and `PermissionRequest` (a hard approval). A
small always-on **collector** tracks every session's state, tails the transcript to extract
*what* is being asked, and serves a **single-pane queue** ranked most-stuck-first. You answer
or skip; your reply is delivered back into the exact session — via tmux `send-keys` (overlays
a terminal workflow with no rewrite) or the Agent SDK's `canUseTool` / streaming input (a
cleaner, programmatic substrate). Full design in [`docs/plan/plan.md`](docs/plan/plan.md).

## Repository layout

- `README.md` — this file
- [`docs/plan/plan.md`](docs/plan/plan.md) — the complete design: problem, capabilities, architecture, phases, open questions
- [`docs/research/claude-code-mechanics.md`](docs/research/claude-code-mechanics.md) — the Claude Code primitives for detect / correlate / deliver
- [`docs/research/related-work.md`](docs/research/related-work.md) — public prior art and how Trail Boss differs
- [`docs/notes/decisions.md`](docs/notes/decisions.md) — naming rationale and key design decisions

## Status

Research / design. No implementation yet. The detection model is settled (`Stop` +
`PermissionRequest` are the two load-bearing signals); the next step is the collector plus the
session→pane registry.
