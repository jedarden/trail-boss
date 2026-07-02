# Tmux Detector Acceptance Test Summary - Iterations 2-5

**Bead:** tb-62m
**Date:** 2026-07-02
**Baseline:** Iteration 1 at 19:38:10 (35s duration, fail with unknown error)

## Test Runs

All 4 additional iterations (2-5) were executed with identical results.

| Run | Timestamp | Duration | Result | Failure | Details |
|-----|-----------|----------|--------|---------|---------|
| 2 | 2026-07-02 ~19:54:06 | ~34s | FAIL | pane_id mismatch | Queue pane_id %22 vs test pane %0 |
| 3 | 2026-07-02 ~19:55:19 | ~34s | FAIL | pane_id mismatch | Queue pane_id %22 vs test pane %0 |
| 4 | 2026-07-02 ~19:56:13 | ~34s | FAIL | pane_id mismatch | Queue pane_id %22 vs test pane %0 |
| 5 | 2026-07-02 ~19:57:05 | ~34s | FAIL | pane_id mismatch | Queue pane_id %22 vs test pane %0 |

## Critical Finding: Persistent Stale Queue Entry

All runs failed with **identical flakiness pattern**:

1. Test clears 6 pre-existing queue entries
2. Queue reports as clean (count=0)
3. Test creates fresh pane %0 in isolated tmux server
4. After waiting for pane to be detected as stuck (~20s)
5. Queue has 1 entry with **pane_id %22** (stale, not our test pane)
6. Test fails verification: %22 != %0

The stale entry appears to be:
- pane_id: %22
- session_id: tmux-%0-1783029002686
- timestamp: 1783029002686 (approximately 20-30 minutes before test runs)

## Flakiness Analysis

**Consistency:** 100% - All 4 runs failed identically
**Type:** Test isolation failure - stale queue state not properly cleared
**Impact:** High - prevents reliable acceptance testing

The test's queue clearing loop at startup is not fully effective. A stale entry is persisting despite:
- Daemon restart between runs
- Explicit queue clearing loop that skips entries until count=0
- Isolated tmux server with custom socket

## Recommendations

1. **Immediate:** The test needs stronger isolation - perhaps database truncation instead of queue skipping
2. **Investigate:** Where is pane %22 coming from? Is it from a previous daemon instance or a different test?
3. **Fix:** The queue clearing logic should clear ALL entries from the database, not just skip them one by one

## Metrics Summary

- Total runs: 5 (including baseline)
- Passed: 0
- Failed: 5
- Success rate: 0%
- Average duration: 34.4s
- Consistent failure mode: pane_id mismatch (%22 vs %0)
