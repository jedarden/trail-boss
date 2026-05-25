# Trail Boss — design plan

The complete design: the problem, the capabilities required, the architecture, the
implementation phases, and the open questions. See
[`../research/claude-code-mechanics.md`](../research/claude-code-mechanics.md) for the
underlying Claude Code primitives and [`../research/related-work.md`](../research/related-work.md)
for prior art.

---

## Problem

You run long-form, human-in-the-loop agentic coding across many concurrent agent sessions,
one per terminal window. Each session periodically stalls waiting on **you**: a permission
prompt, a plan to approve, a clarifying question, or a finished turn awaiting the next
instruction. Today you find those stalls by **manually cycling windows**. That polling is the
bottleneck: most of your time goes to *finding* the session that needs you, not *answering*
it, and blocked sessions burn wall-clock while otherwise-parallel work waits.

Invert the loop: stuck sessions raise their hand, and a single pane presents them as a
**prioritized queue of pending decisions**, most-stuck first. You answer or skip; the reply is
delivered back into the exact session, which unblocks and resumes. You never go hunting again.

---

## What is needed

Five capabilities. The hard parts are #1 (a reliable "I'm blocked" signal) and #5 (getting the
reply back into the *exact* session). The rest is plumbing.

### 1. A blocked-state signal from every session — Claude Code hooks

Each session emits an event the instant it starts waiting on a human. Claude Code's hook
system is the native mechanism; configure these in `~/.claude/settings.json` (or a project
`.claude/settings.json`) to POST their stdin JSON to the collector:

| Hook | Fires when | Use |
|------|-----------|-----|
| `Stop` | the turn finished; session is idle, waiting for the next prompt | enqueue **ready for next** — the reliable idle signal |
| `PermissionRequest` | a tool needs approval | enqueue an **allow/deny** decision |
| `Notification` | Claude needs attention (permission prompt, long idle) * | supplementary signal |
| `UserPromptSubmit` | input was submitted | **dequeue** (the block is resolved) |
| `SessionStart` / `SessionEnd` | session opens / closes | register / retire the session |

`Stop` is the backbone — it fires every time a turn completes and the session sits waiting, so
"idle, wants the next instruction" needs no polling. `PermissionRequest` covers hard blocks.
\* `Notification`'s exact trigger conditions are less documented; treat it as supplementary.

Every payload carries `session_id`, `transcript_path`, and `cwd` — the correlation keys.

### 2. A central collector + live state store

A small always-on service that ingests hook POSTs and maintains the authoritative set of
sessions and their status: `{session_id, project, status: running|blocked|idle, reason,
blocked_since, context_ref}`. SQLite is enough; it broadcasts changes to the UI over
WebSocket/SSE.

### 3. Context extraction — *what* is each session asking?

A "blocked" status is useless without the question. Two sources:

- **Transcript JSONL** (`transcript_path`): append-only, one message per line, tailable in
  real time. The last assistant / tool-use entry holds the permission request, the plan text,
  or the question body.
- **tmux `capture-pane -p`** as a literal fallback: scrape the visible prompt verbatim (useful
  when the transcript lags the on-screen menu).

### 4. The Trail Boss pane — the attention queue

A single-pane queue/inbox sorted by policy (most-stuck-first), rendering each item's context,
with a reply box and decision keys, **keyboard-driven** for speed. Can be a TUI or a thin web
page (better for rich plan/diff rendering and remote access). `skip` = advance the cursor only.

### 5. The input-delivery path — reply → the right session

The crux; it forks on substrate:

- **Substrate A — tmux `send-keys` (overlays a terminal workflow, no rewrite).** A
  `SessionStart` hook records the session's `$TMUX_PANE` into the registry, mapping
  `session_id → pane`. To answer, the dispatcher runs `tmux send-keys -t <pane> '<reply>'
  Enter`, or sends the menu choice for a permission prompt. Sessions stay interactive; the pane
  is just driven remotely. Lowest-friction MVP.
- **Substrate B — Agent SDK (cleaner, but a rewrite).** Run sessions under the Python/TS Agent
  SDK. The `canUseTool` callback turns every permission prompt into a programmatic await that
  can pend indefinitely while it waits for your remote allow/deny (and can return *modified*
  tool input). Streaming input delivers follow-up turns over a long-lived channel. **Note:**
  headless `claude -p` is *not* a path — it's one-shot and cannot stream input into a running
  session; only the SDK can.

**Recommendation:** build the MVP on **Substrate A** (hooks for detection + tmux for delivery)
— zero rewrite. Treat Substrate B as v2 once the queue/UX is proven.

---

## Architecture (Substrate A / MVP)

```
  window 1 ─┐  agent session (hooks → curl)
  window 2 ─┤        │ PermissionRequest / Stop / SessionStart
  window N ─┘        ▼
              ┌──────────────────────┐     tail transcript JSONL
              │  Collector + store    │◀─── + tmux capture-pane (context)
              │  (SQLite, WS/SSE)     │
              │  session_id → pane    │
              └──────────┬───────────┘
                         │ WS/SSE: queue state
                         ▼
              ┌──────────────────────┐
              │  Trail Boss pane      │  most-stuck first
              │  read · reply · skip  │
              └──────────┬───────────┘
                         │ reply / decision
                         ▼
              tmux send-keys -t <pane>  →  session unblocks, resumes
```

### Components

1. **Emitter** — hook scripts in `~/.claude/settings.json`, present in every session:
   - `trailboss-emit.sh` — passes stdin JSON through for `PermissionRequest`, `Notification`,
     `Stop`, `UserPromptSubmit`, `SessionEnd`.
   - `trailboss-register.sh` — on `SessionStart`, enriches the payload with `$TMUX_PANE`, the
     tmux window name, and the git repo at `cwd`, then POSTs. This is what makes reply-delivery
     possible.
2. **Collector** — ingests events, upserts session state, holds the
   `session_id → {pane, project, transcript_path}` registry, tails transcripts for context,
   broadcasts queue state.
3. **Trail Boss pane** — subscribes to the collector, renders the queue, captures
   replies/decisions, POSTs them to `/reply`.
4. **Dispatcher** — resolves the target pane (Substrate A) or the pending `canUseTool` future
   (Substrate B) and delivers the input.

### Session state machine

```
            SessionStart
                │
                ▼
           ┌─────────┐   PreToolUse / activity
           │ RUNNING │◀──────────────────────────┐
           └────┬────┘                            │
   PermissionRequest │ Stop                       │ UserPromptSubmit
                ▼                                  │  (block resolved)
           ┌─────────┐                             │
           │ BLOCKED │─────────────────────────────┘
           └────┬────┘   reply delivered → input lands → session resumes
                │ SessionEnd
                ▼
            ┌────────┐
            │ RETIRED│
            └────────┘
```

`BLOCKED` carries a **reason** (`permission` | `plan` | `question` | `idle`) and a
`blocked_since` timestamp. `reason` drives both card layout and queue priority.

### Queue & skip semantics

- **Membership:** every `BLOCKED` session is a queue item; `RUNNING`/`RETIRED` are not.
- **Ordering (default):** permission blocks (`permission|plan|question`, time-sensitive)
  outrank `idle` (from `Stop`, opportunistic); within a tier, oldest `blocked_since` first.
- **Focus cursor:** starts at the head. `enter` focuses (expands context); `tab`/`skip`
  advances **without** answering — the item stays `BLOCKED` and re-surfaces (optionally with a
  small penalty so a just-skipped item doesn't bounce straight back to the top).
- **Dequeue:** the `UserPromptSubmit` hook fires when input lands — *whether the reply came
  from the pane or because you answered directly in the terminal*. Either way the item leaves
  the queue, so it never lies.
- **Staleness:** if a session retires (`SessionEnd`) while queued, drop the item.

### Session → pane registry (Substrate A)

The one piece Claude Code does not hand you. Built by `trailboss-register.sh` on `SessionStart`:

```bash
#!/usr/bin/env bash
# trailboss-register.sh — enrich SessionStart with tmux + repo, then POST
payload="$(cat)"                                   # event JSON on stdin
pane="${TMUX_PANE:-}"                               # e.g. %12
win="$(tmux display-message -p -t "$pane" '#S:#I.#P' 2>/dev/null || true)"
repo="$(git -C "$(printf '%s' "$payload" | jq -r .cwd)" rev-parse --show-toplevel 2>/dev/null | xargs -r basename)"
printf '%s' "$payload" \
  | jq --arg pane "$pane" --arg win "$win" --arg repo "$repo" \
       '. + {tmux_pane:$pane, tmux_window:$win, repo:$repo}' \
  | curl -s -X POST http://localhost:4000/event --data-binary @-
```

Delivery resolves `session_id → tmux_pane` and runs `send-keys`. A session with no pane
(launched outside tmux, or under the SDK) falls back to Substrate B.

> **Only deliver human-authored input.** The dispatcher must `send-keys` only content the human
> explicitly typed in the pane — never synthesize or auto-answer a session.

### Substrate B variant (Agent SDK)

When sessions run under the Agent SDK, the collector holds pending decision objects directly
instead of a pane map: on `canUseTool`, the SDK process registers a **pending future**
(`session_id`, tool, input) and awaits; the UI renders it; your allow/deny/edit resolves the
future via `/reply`; the callback returns `{behavior, updatedInput?}` and the session proceeds.
Removes the tmux scraping/`send-keys` fragility and gives input-modification for free, at the
cost of moving sessions off the terminal. Recommended as v2.

---

## Implementation phases (Substrate A)

1. **Probe** `Notification` / `Stop` firing behavior to lock the detection model.
2. **Emitter** — the two hook scripts + `settings.json` wiring.
3. **Collector** — ingest endpoint, SQLite state, registry, WS broadcast.
4. **Context** — transcript tailer + `capture-pane` fallback.
5. **Trail Boss pane** — minimal TUI or web page: queue list, focused-card context, reply box,
   skip.
6. **Dispatcher** — `send-keys` delivery + `UserPromptSubmit` dequeue. Close the loop.
7. Iterate on ordering policy and re-surface penalty.

---

## Open questions

1. **Idle vs. blocked priority** — `Stop` reliably signals "finished its turn, wants the next
   instruction," so idle detection is solved; the open question is *ranking* it below
   time-sensitive permission blocks. Confirm the policy.
2. **`Notification` value-add** — with `Stop` + `PermissionRequest` covering idle and hard
   blocks, does `Notification` surface anything they miss (e.g., a long-idle nudge)? If not,
   drop it from the emitter.
3. **Reply round-trip fidelity** — does `send-keys` survive multi-line input, paste, or a menu
   selection intact? Test per prompt type.
4. **Stale items** — a skipped item you answer directly in the terminal should dequeue via the
   `UserPromptSubmit` hook; confirm that closes the loop.
5. **Ordering policy** — most-stuck-first vs. project-priority vs. cheapest-to-answer-first.
6. **Remote access** — local TUI vs. a web page reachable from a phone; web wins for plan/diff
   rendering and mobility.
7. **Concurrency ceiling** — at what session count does the human saturate regardless of
   routing? The router buys throughput, not infinite capacity.
