# Bead Worker Starvation Alert (tb-1x0l)

## Root Cause

The `bead-worker` workflow script contains a critical bug: it attempts to call `Bash()` directly from the workflow script (line 39+), but workflow scripts run in a pure JavaScript execution context without direct tool access.

**Error:** `Error: Bash is not defined at <anonymous> (workflow.js:39:34)`

## Details

The workflow script at:
`~/.claude/projects/-home-coding-trail-boss/.../workflows/scripts/bead-worker-wf_*.js`

Attempts to:
```javascript
const raw = await Bash({
  command: `br claim --assignee "${WORKER_ID}" --json -w "${WORKSPACE}" 2>/dev/null`
});
```

But workflow scripts cannot call tool functions directly. They must use `agent()` to spawn subagents that then use tools.

## Impact

- Bead worker fails immediately on startup
- No beads are ever claimed or processed
- Starvation alert fires because 0 beads found despite 9 open beads in workspace

## Fix Applied

**File:** `/home/coding/.claude/workflows/bead-worker.js`

**Changes:**
1. Created `runBash()` helper that uses `agent()` with structured output schema
2. Replaced all direct `Bash()` calls with `runBash()` agent calls
3. Added `BASH_OUTPUT_SCHEMA` and `BEAD_STATUS_SCHEMA` for structured agent responses
4. Workflow now properly uses agents to execute bash commands

**Test:** Re-run the bead-worker to verify it can now claim and process beads.

## Verification Steps

1. Run bead-worker: `Workflow({ name: "bead-worker" })`
2. Should see "Claim" phase executing `br claim` commands
3. Should see beads claimed and dispatched
4. Should not see "Bash is not defined" error
