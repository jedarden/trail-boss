# Bead tb-1zrf: Starvation Alert - Self-Blocking Dependency Fix

## Issue
Starvation alert: "Open beads exist but Pluck found none — possible configuration error."
- 9 open beads in workspace
- 0 beads found by Pluck (bead-worker)

## Root Cause
`tb-1me` had a **self-blocking dependency** - it blocked itself via a dependency entry added by a batch operation on 2026-07-02T15:25:21.217314Z.

This created a deadlock:
1. `tb-1me` (deferred) could not be claimed because it blocked itself
2. All non-deferred open beads (tb-163k, tb-2ir, tb-2lh, tb-3iu, tb-5wj, tb-62m) were blocked by `tb-1me`
3. Pluck found 0 claimable beads

## Resolution
Removed the self-blocking dependency:
```bash
br dep remove tb-1me tb-1me -w .
```

After removal, `br ready` now returns `tb-1me` as claimable.

## Lessons
- Self-blocking dependencies can silently starve the bead worker
- The starvation alert mechanism correctly surfaced the issue
- Always validate dependency chains after batch operations

## Date Resolved
2026-07-02
