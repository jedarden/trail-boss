# Claude Code mechanics: detect, correlate, deliver

The three primitives Trail Boss stands on, with what's confirmed and what's uncertain.
Anything marked **(verify)** should be probed empirically before depending on it — Claude
Code's hook surface evolves and some semantics are undocumented.

---

## 1. DETECT — which hook says a session is blocked

Hooks live in `~/.claude/settings.json` (user-global) or `.claude/settings.json` (per-project).
Each `command` hook receives the **event JSON on stdin**. **Every** hook routes through the same
`trailboss-emit.sh` — a thin wrapper that forwards stdin *and* injects `$TMUX_PANE` from the
environment (the pane is not in the payload; see §2). A bare `curl` of stdin alone is **not**
enough, because it would drop the env-only pane mapping. `SessionStart` is **not** special — it
uses the same emitter; the registry self-heals on every event:

```json
{
  "hooks": {
    "PermissionRequest": [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "Stop":              [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "UserPromptSubmit":  [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "SessionStart":      [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ],
    "SessionEnd":        [ { "hooks": [ { "type": "command", "command": "~/.claude/trailboss-emit.sh" } ] } ]
  }
}
```

`trailboss-emit.sh` is essentially:
`curl -s -X POST http://localhost:4000/event --data-binary @- -H "X-Tmux-Pane: $TMUX_PANE"`
(or it merges `$TMUX_PANE` into the JSON body before POSTing).

Events relevant to "needs a human":

| Event | Meaning for the queue | Confidence |
|-------|----------------------|------------|
| `Stop` | **Turn finished; session waiting for the next instruction.** Enqueue a stuck item. | Confirmed firing (probe) |
| `PermissionRequest` | Session blocked mid-turn on approval. Emits **no** `Stop`, so it is the only signal for the permission case. Enqueue a stuck item. | Exists; firing/payload not yet probed |
| `SubagentStop` | A subagent finished — *not* a human-input point; ignored. | Exists; not probed (ignored regardless) |
| `UserPromptSubmit` | Human submitted input → block resolved → **dequeue**. | Confirmed |
| `SessionStart` | Register the session; capture `$TMUX_PANE`. | Confirmed firing (probe) |
| `SessionEnd` | Retire the session. | Exists; firing not yet probed |
| `PreToolUse` / `PostToolUse` | Activity telemetry (the "running" state), not blocks. | Confirmed |

> **Detection model (settled):** the two enqueue triggers are `Stop` (turn finished, waiting)
> and `PermissionRequest` (blocked mid-turn). **Both are required** — a permission-blocked
> session is mid-turn and emits no `Stop`, so without `PermissionRequest` it would never be
> detected. They are treated identically (a flat stuck item; `reason` is display-only, never a
> priority). `Notification` was evaluated and **dropped** — `Stop` + `PermissionRequest` cover
> every stuck case. See `../plan/plan.md` ("Detection model" and the resolved-questions list).

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

- `permission_mode` — captured as-is for display only; Trail Boss does not branch on it (the
  `plan` value can appear in the payload even though vanilla plan mode is a non-goal).
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

## 4. DELIVER — route the operator to the live session (navigation, not relay)

Trail Boss does **not** inject answers. It navigates the operator to the live pane, where they
interact with the real prompt directly (see `../plan/plan.md`, "Navigator, not relay" and the
delivery decision in `../notes/decisions.md`). The relevant primitives, all tmux-server-global
so they work from outside tmux:

```bash
# bring the operator's client to the stuck pane (pane ids like %446 are global)
tmux switch-client -t "$(tmux display -p -t %446 '#{session_name}')"
tmux select-window -t %446
tmux select-pane   -t %446
# optional co-display: link the target window into a Trail Boss view, then unlink
tmux link-window -s <src-session>:<window> -t trailboss: ; tmux unlink-window -t trailboss:<n>
```

- Primary delivery is **navigation** — the operator types into the genuine CLI, so there is no
  keystroke-fidelity problem and "edit before allow" is native.
- **Secondary (optional):** `tmux send-keys -t %446 -l '<text>'` then `send-keys -t %446 Enter`
  for plain-text submission (basic submission confirmed in the probe). Not the primary path; the
  daemon never sends *synthesized* input — only human-authored text, and only if this path is
  enabled.

### Rejected delivery alternatives

- **Resume-to-deliver** (`claude --resume <id>` in a second process) does **not** reach the
  original live pane — a live interactive CLI holds in-memory state and does not re-read its
  transcript; concurrent attach risks divergence. `--fork-session` confirms `--resume` reuses
  the session. Only viable in a no-resident-process model, which is rejected for v1.
- **Agent SDK `canUseTool` + streaming input** would allow programmatic permission gating with
  `updatedInput`, but requires running sessions under the SDK instead of the terminal —
  deferred; the tmux-navigator model fits the existing workflow.
- **`claude --remote-control`** routes to the claude.ai / desktop / mobile surface, not a local
  channel — useless for a same-host tool.
- **Headless `claude -p`** is one-shot and cannot stream input into a running session.

---

## Summary

| Need | Primitive | Identifier / flag | Confidence |
|------|-----------|-------------------|------------|
| Detect waiting for next instruction | `Stop` hook | stdin JSON | confirmed firing (probe) |
| Detect permission block | `PermissionRequest` hook | stdin JSON | exists; not yet probed |
| Detect resolved block | `UserPromptSubmit` hook | `session_id` | confirmed |
| Correlate to session/repo | any hook payload + env | `session_id`, `cwd`, `transcript_path`, `CLAUDE_CODE_SESSION_ID` | confirmed (probe) |
| Correlate to tmux pane | any emit hook | `$TMUX_PANE` (in hook env) | confirmed (probe) |
| Read the question | `Stop` payload `last_assistant_message` / transcript / `capture-pane` | payload / `transcript_path` / pane | confirmed (probe) |
| Deliver (primary) | tmux navigation (`switch-client`/`select-window`/`select-pane`) | pane id | confirmed primitives |
| Deliver (secondary, optional) | tmux `send-keys -t <pane>` (human-authored text only) | pane id | basic submission confirmed |
| Rejected: resume / SDK / remote-control / `-p` | — | — | see "Rejected" above |
