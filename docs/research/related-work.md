# Related work

Trail Boss sits at a specific point in the agent-tooling design space. The two axes that
distinguish it: **who initiates** (do you poll the agents, or do they surface to you?) and
**observe vs. act** (does the tool just show state, or let you respond in place?).

## Public prior art

### [`disler/claude-code-hooks-multi-agent-observability`](https://github.com/disler/claude-code-hooks-multi-agent-observability)

A self-hosted, real-time dashboard that captures Claude Code hook events and visualizes agent
activity (sessions, tool calls, errors) over WebSocket. It proves the **detection + correlation
layer** Trail Boss needs: hooks → collector → live UI, keyed by `session_id`.

**How Trail Boss differs:** it is *observability*, not *action*. It shows *that* a session is
waiting; Trail Boss adds the missing half — surfacing the blocked session and **navigating the
operator to the live pane** to act on it (it never injects input; see "Navigator, not relay" in
the plan). Its collector is a strong starting point to fork; Trail Boss extends the read-only
event store with a self-healing session→pane registry and a tmux navigation layer. It reuses the
SQLite event store, not the WebSocket/browser-UI layer (presentation is tmux, not a web app).

### [`langchain-ai/agent-inbox`](https://github.com/langchain-ai/agent-inbox)

An inbox UX for human-in-the-loop agents: LangGraph agents hit an `interrupt`, and the inbox
presents pending items for a human to accept, edit, respond to, or ignore. This is the closest
public analog to Trail Boss's core idea — a **queue of agents waiting on a human**.

**How Trail Boss differs:** Agent Inbox is bound to the LangGraph runtime and its `interrupt`
primitive. Trail Boss targets **interactive terminal coding agents** (e.g. Claude Code
sessions): detection comes from Claude Code **hooks** rather than framework interrupts, and the
operator acts by being **navigated to the live tmux pane** — not by the tool replying through a
graph runtime. It also adds **skip / re-surface** semantics and an **auto-advance FIFO depletion
loop** (oldest-stuck first, no priority) tuned for an operator draining many live sessions.

## Positioning

> Observability dashboards *watch* agents. Broadcast/dispatch tools let you *push* requests out
> to agents. Trail Boss does the inverse and adds action: it **surfaces whichever agent is
> stuck and lets you answer or skip from one pane** — the human-in-the-loop counterpart to
> autonomous agent fleets, which remove the human entirely.

## Concrete reuse

- **Collector backend** → the hook-native event store from `disler/...observability`
  (SQLite + hook ingest) is a clean fork point; extend it with the self-healing session→pane
  registry and the tmux navigation layer. Drop its WebSocket/browser-UI half — Trail Boss's
  presentation is tmux (`display-popup`), not a web client.
- **Inbox UX patterns** → `langchain-ai/agent-inbox` for the accept/respond/ignore interaction
  model, mapped onto Trail Boss's two stuck reasons (`permission`, `stopped`).
