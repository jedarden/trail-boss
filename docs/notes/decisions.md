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
returns to a human, so there is a clean boundary with no false positives: while a session is
actively working it emits `PreToolUse`/`PostToolUse`, never `Stop`. A session only counts as
waiting once `Stop` or `PermissionRequest` has fired and no `UserPromptSubmit` has come since.

### `Stop` + `PermissionRequest` are the load-bearing signals

`Stop` reliably means "turn finished, idle, waiting for the next prompt" — so the "wants the
next instruction" case needs no transcript polling. `PermissionRequest` covers hard approval
blocks. `Notification` is kept optional pending a probe of whether it adds anything those two
miss.

### Substrate A (tmux) first, Substrate B (SDK) later

Two ways to deliver a reply back into a session:

- **A — tmux `send-keys`**: overlays an existing terminal workflow with zero rewrite. A
  `SessionStart` hook captures `$TMUX_PANE` to map `session_id → pane`. Chosen for the MVP.
- **B — Agent SDK `canUseTool` + streaming input**: programmatic, can pend on a permission
  decision indefinitely and return modified input, but requires running sessions under the SDK
  instead of the terminal. Deferred to v2.

Headless `claude -p` is explicitly *not* a delivery path — it is one-shot and cannot stream
input into a running session.

### Only deliver human-authored input

The dispatcher must `send-keys` only content the human explicitly typed in the pane — it never
synthesizes or auto-answers a session. Trail Boss routes attention; it does not act on the
human's behalf.
