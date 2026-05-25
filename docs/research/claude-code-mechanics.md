# Claude Code mechanics: detect, correlate, deliver

The three primitives Trail Boss stands on, with what's confirmed and what's uncertain.
Anything marked **(verify)** should be probed empirically before depending on it — Claude
Code's hook surface evolves and some semantics are undocumented.

---

## 1. DETECT — which hook says a session is blocked

Hooks live in `~/.claude/settings.json` (user-global) or `.claude/settings.json` (per-project).
Each `command` hook receives the **event JSON on stdin**, so a one-liner that pipes stdin to
the collector is enough:

```json
{
  "hooks": {
    "PermissionRequest": [
      { "hooks": [ { "type": "command",
                     "command": "curl -s -X POST http://localhost:4000/event --data-binary @-" } ] }
    ],
    "Notification":      [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "Stop":              [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "UserPromptSubmit":  [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "SessionStart":      [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-register.sh" } ] } ],
    "SessionEnd":        [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ]
  }
}
```

Events relevant to "needs a human":

| Event | Meaning for the queue | Confidence |
|-------|----------------------|------------|
| `Stop` | **Turn finished; session idle, waiting for the next prompt.** The reliable idle signal — fires every time a turn completes. Enqueue "ready for next." | Confirmed |
| `PermissionRequest` | Hard block: a tool wants approval. Enqueue allow/deny. | Confirmed exists |
| `Notification` | Claude notifying the user (permission prompt, long-idle nudge). Supplementary; **trigger conditions less documented.** | **(verify, optional)** |
| `SubagentStop` | A subagent finished — usually *not* a human-input point; ignore. | Confirmed |
| `UserPromptSubmit` | Human submitted input → block resolved → **dequeue**. | Confirmed |
| `SessionStart` / `SessionEnd` | Register / retire the session. | Confirmed |
| `PreToolUse` / `PostToolUse` | Activity telemetry (the "running" state), not blocks. | Confirmed |

> **Detection model (settled):** the two load-bearing signals are `Stop` (idle, waiting for the
> next prompt) and `PermissionRequest` (a hard block). `Stop` makes the "wants the next
> instruction" case free — no polling. `Notification` is supplementary; the only open question
> is whether it surfaces anything those two miss (e.g., a long-idle nudge), and if not it can
> be dropped. Optional probe: log `Notification` alongside `Stop`/`PermissionRequest` across
> (a) a permission prompt, (b) plan-mode approval, (c) a clarifying question, (d) a finished
> turn at an empty prompt, and see if it ever adds signal.

---

## 2. CORRELATE — tie an event to a session, repo, and pane

Every hook payload includes stable identifiers:

```json
{
  "session_id":      "abc-123-uuid",
  "transcript_path": "~/.claude/projects/<project-slug>/<session-id>.jsonl",
  "cwd":             "/path/to/repo",
  "hook_event_name": "PermissionRequest",
  "permission_mode": "default|plan|acceptEdits|bypassPermissions"
}
```

- `session_id` — primary key; stable across resume/fork.
- `cwd` — derive the project/repo label.
- `transcript_path` — the JSONL to tail for context.
- **tmux pane** — *not* in the payload, but **available in the hook's environment as
  `$TMUX_PANE`** (confirmed by probe 2026-05-25, in both interactive and `-p` modes). Capture it
  on **every** emit and POST it alongside `session_id`, so the `session_id → pane` registry
  self-heals across resume / pane reuse / window moves. Pane ids (`%446`) are tmux-server-global
  and addressable by any `tmux` command from outside tmux.

**Confirmed environment available to hook commands (probe 2026-05-25):** `TMUX_PANE`, `TMUX`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_ENTRYPOINT` (`cli` interactive vs
`sdk-cli` for `-p`), `CLAUDECODE=1`, `TERM_PROGRAM=tmux`, `CLAUDE_ENV_FILE` (per-session state
dir). So identity is available both as env vars and in the payload.

---

## 3. CONTEXT — reconstruct what the session is asking

### From the `Stop` payload directly (primary, no transcript needed)

**Confirmed (probe 2026-05-25):** the `Stop` payload includes `last_assistant_message` — what
the agent just said — so the queue can render context straight from the hook. It also carries
`permission_mode`, `effort`, `stop_hook_active`, `background_tasks`, `session_crons`. This makes
transcript tailing an enhancement, not a requirement, for the stopped case.

### Transcript JSONL (deeper context)

`transcript_path` is an append-only JSONL — one object per line, tailable in real time. The
last assistant / tool-use entry holds the permission request or the question body in full. The
collector tails from the last seen offset and extracts the trailing decision context. It is
also the **ground truth** for the reconcile loop (see the plan): if the transcript has advanced
past the last `Stop`, the session progressed → dequeue.

### tmux capture-pane (fallback / literal view)

```bash
tmux capture-pane -t <pane> -p        # plain text of the visible pane
```

Use when the on-screen menu is needed verbatim, or when the transcript write lags the rendered
prompt. Cheap; poll on demand.

---

## 4. DELIVER — get the reply back into the exact session

### Substrate A — tmux `send-keys` (overlays a terminal workflow)

```bash
# free-text reply (a clarifying answer or the next instruction)
tmux send-keys -t <pane> -l 'shard by tenant; tenants are the hard isolation boundary'
tmux send-keys -t <pane> Enter

# permission menu choice (send the option key the prompt expects)
tmux send-keys -t <pane> '1'           # or 'y' / arrow+Enter, depending on the prompt
```

- `-l` sends the argument literally; send `Enter` separately.
- Requires the `session_id → pane` mapping from the `SessionStart` hook.
- **Verify** multi-line/paste fidelity and how each prompt type consumes keystrokes.
- Works regardless of how the session was launched — it stays a normal interactive session.

### Substrate B — Agent SDK (the clean rewrite)

If sessions run under the Python/TypeScript Agent SDK:

- **`canUseTool` callback** (`can_use_tool` in Python) — fires for any tool needing approval and
  for clarifying questions. It can **await indefinitely** while the orchestrator collects your
  remote decision, then returns `{ behavior: "allow" | "deny", updatedInput?, message? }` —
  including a *modified* tool input. The cleanest "answer from elsewhere" hook: execution pauses
  until you respond.
- **Streaming input** — the SDK accepts an async-iterable prompt stream, so follow-up turns are
  delivered programmatically over a long-lived channel.
- **Resume** — `resume: <session_id>` to continue a specific session.

### Why headless `claude -p` is NOT a delivery path

`claude -p` (print/headless) with `--output-format stream-json` / `--input-format stream-json`
is **one-shot**: it cannot stream additional user messages into an already-running session, and
interactive permission prompting is unavailable (you must pre-authorize with `--allowedTools`
or wire `--permission-prompt-tool <mcp_tool>`, whose payload schema is undocumented —
**(verify)**). Use the SDK, not `-p`, for Substrate B.

---

## Summary

| Need | Primitive | Identifier / flag | Confidence |
|------|-----------|-------------------|------------|
| Detect idle / waiting for next prompt | `Stop` hook | stdin JSON | confirmed (primary idle signal) |
| Detect permission block | `PermissionRequest` hook | stdin JSON | confirmed |
| Detect long-idle nudge (optional) | `Notification` hook | stdin JSON | **(verify, optional)** |
| Detect resolved block | `UserPromptSubmit` hook | `session_id` | confirmed |
| Correlate to session/repo | any hook payload | `session_id`, `cwd`, `transcript_path` | confirmed |
| Correlate to tmux pane | `SessionStart` hook | `$TMUX_PANE` (capture in script) | confirmed (you wire it) |
| Read the question | transcript JSONL / `capture-pane` | `transcript_path` / pane | confirmed |
| Deliver reply (overlay) | tmux `send-keys -t <pane>` | pane id | confirmed |
| Deliver reply (rewrite) | Agent SDK `canUseTool` + streaming input | `session_id` | confirmed (SDK only) |
| Deliver reply (headless) | — | not viable (`-p` is one-shot) | confirmed limitation |
