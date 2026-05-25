# Decisions & rationale

## Naming

**Trail Boss** — on a cattle drive, the trail boss is in overall command: sets the direction,
makes the calls, and rides in when a steer bogs down or strays. The product runs a *herd* of
agent sessions; when one gets stuck it reports in, and you — the trail boss — ride over and set
it right. The metaphor maps cleanly onto the mechanism:

- **the herd grazing the range** → sessions working autonomously
- **a steer bogs down or strays** → a `Stop` / `PermissionRequest` hook fires; the collector
  flags the session stuck
- **the trail boss rides over and sets it right** → you read the context and give the order
  (reply) or wave it on (skip); ranking surfaces the most-stuck first

### Names considered and rejected

- **`agent-inbox`** — clearest literal description, but collides head-on with
  [`langchain-ai/agent-inbox`](https://github.com/langchain-ai/agent-inbox), an existing
  human-in-the-loop inbox for LangGraph agents. Would read as derivative and lose every search.
- **`agent-attention`** — names the value prop (your attention is the scarce resource being
  routed), but risks reading as the ML "attention" mechanism.
- **`agent-central`** — self-explanatory but generic, and "central" reads like a passive
  dashboard/hub rather than an act-on-the-stuck-one tool.

Trail Boss keeps a memorable, distinctive identity; the tagline carries the legibility for
newcomers.

## Design decisions

### Hooks, not polling

Detection is event-driven via Claude Code hooks. A session emits a signal the moment control
returns to a human: while actively working it emits `PreToolUse`/`PostToolUse`, never `Stop`.
A session counts as waiting only once `Stop` or `PermissionRequest` has fired and no
`UserPromptSubmit` has come since. **Confirmed by probe (2026-05-25):** both `SessionStart` and
`Stop` fire in interactive and `-p` modes, the `Stop` payload carries `last_assistant_message`
(queue context for free), and hook commands inherit the ambient environment.

### Stopped = needs attention

A stopped session cannot progress toward its goal, so it needs intervention by definition.
There is no "finished but fine" state to distinguish — **every `Stop` is a queue item.** This
collapses the fuzzy idle-vs-done question and makes `Stop` + `PermissionRequest` sufficient;
`Notification` stays optional pending a probe of whether it adds anything they miss.

### Navigator, not relay (the delivery model)

Trail Boss routes *attention*, it does not inject *input*. Sessions stay as long-running live
CLIs in tmux panes (Model A), and delivery happens by navigating the operator to the live pane
(`switch-client`/`select-window`/`select-pane`, optionally `link-window` to co-display) where
they interact with the real prompt directly. This dissolves the send-keys fidelity problem,
makes "edit before allow" native (you just type), and means no synthesized input ever reaches a
session.

Rejected delivery alternatives:

- **Resume-to-deliver** (`claude --resume <id>` in a second process): a live interactive CLI
  holds in-memory state and does not re-read its transcript, so a resumed process's reply never
  reaches the original pane; concurrent attach risks transcript divergence. `--fork-session`
  confirms plain `--resume` reuses the session. Only viable in a no-resident-process model
  (Model B), which we rejected for v1.
- **`send-keys` relay as the primary path:** retained only as a secondary plain-text option
  (basic submission confirmed working); native interaction is preferred.
- **`claude --remote-control`:** routes to the claude.ai / desktop / mobile surface, not a local
  channel — useless for a same-host tool.
- **Agent SDK `canUseTool` (Model B):** programmatic permission gating with `updatedInput` is
  attractive, but requires running sessions under the SDK instead of the terminal — deferred;
  the tmux-navigator model fits the existing workflow and the durability requirement.

### Same-host daemon, durable via tmux

Trail Boss does not need to live *inside* tmux to drive it — tmux is client/server, so any
same-user process issues `tmux` commands to the server (pane ids are server-global). The
control plane is an always-on daemon; presentation is transient (`display-popup` + keybinding).
But for durability across SSH disconnect the daemon must survive SIGHUP, so it runs **in its own
tmux window** (simplest) or under **`systemd --user`** (also survives reboot; tmux does not).
Agents already persist because the tmux server is host-side. While disconnected, the daemon and
hooks keep running, so the queue accumulates the backlog and disconnecting becomes a non-event.

### The transcript is ground truth

Hooks are a low-latency notification; the transcript JSONL is authoritative. A reconcile loop
corrects dropped hook POSTs, daemon restarts, and "answered directly in the pane" by checking
whether a session's transcript has advanced past its last `Stop`.
