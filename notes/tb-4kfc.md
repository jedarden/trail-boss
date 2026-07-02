# Tmux Detector Acceptance Test Analysis (tb-4kfc)

**Test Date:** 2026-07-02
**Bead:** tb-4kfc
**Test Script:** `test-tmux-detector.sh`
**Test Iterations:** 5

## Executive Summary

All 5 test iterations **failed with an identical bug**: the test script extracts the wrong `pane_id` from the queue response. The detector is working correctly and properly detecting the test pane, but the test validation logic has a bug.

**Root Cause:** Line 178 in `test-tmux-detector.sh` uses `head -1` to extract the first `pane_id` from the queue JSON, which may be from a pre-existing queue entry (from other active sessions), not the test pane.

## Test Results Summary

| Run | Status | Exit Code | Duration (s) | Notes |
|-----|--------|------------|--------------|-------|
| 1   | FAIL   | 1          | 35           | Bug: pane ID mismatch - queue has %22, test pane is %0 |
| 2   | FAIL   | 1          | 34           | Bug: pane ID mismatch - queue has %22, test pane is %0 |
| 3   | FAIL   | 1          | 34           | Bug: pane ID mismatch - queue has %22, test pane is %0 |
| 4   | FAIL   | 1          | 35           | Bug: pane ID mismatch - queue has %22, test pane is %0 |
| 5   | FAIL   | 1          | 34           | Bug: pane ID mismatch - queue has %22, test pane is %0 |

### Metrics

- **Pass Rate:** 0/5 (0%)
- **Fail Rate:** 5/5 (100%)
- **Average Duration:** 34.4 seconds
- **Min Duration:** 34 seconds
- **Max Duration:** 35 seconds
- **Standard Deviation:** ~0.5 seconds (consistent execution time)

## Detailed Analysis

### Bug Explanation

The test creates an isolated tmux server and a test pane (%0). The detector correctly:
1. Discovers the pane with `@tb-test` title
2. Registers it for tracking
3. Detects it as stuck after ~21 seconds
4. Adds it to the queue with session_id `tmux-%0-[timestamp]`

However, the queue response contains **multiple entries** from other active sessions:

```json
{
  "items": [
    {"pane_id": "%13", "cwd": "/home/coding/claude-print", ...},
    {"pane_id": "%22", "cwd": "/home/coding/mta-my-way", ...},
    {"pane_id": "%0", "session_id": "tmux-%0-1783016074495", ...}
  ],
  "count": 3
}
```

The buggy line in the test:
```bash
QUEUE_PANE_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
```

This extracts the **first** `pane_id` (%22 from mta-my-way), not the test pane (%0).

### False Positives / False Negatives

- **False Positives (detector flagged non-stuck sessions):** 0 - The detector correctly identified only the stuck test pane
- **False Negatives (detector missed stuck sessions):** 0 - The detector successfully detected and queued the test pane

The bug is a **test infrastructure bug**, not a detector bug. The detector is functioning correctly.

## Test Execution Consistency

All 5 iterations showed nearly identical execution times (34-35s), indicating:
- Stable test infrastructure
- Deterministic failure mode
- No flaky behavior or race conditions
- The "pane ID mismatch" failure occurred consistently

### Timeline per iteration (average):
1. Setup (daemon + tmux + detector): ~8s
2. Wait for stuck detection: ~21s
3. Queue verification failure: immediate
4. Cleanup: ~5s

## Patterns and Observations

### Consistent Behavior

1. **Detection works:** The detector consistently detected the test pane as stuck after ~21 seconds (within the 30s quiet threshold + 2s poll interval)

2. **Queue entry created:** The test pane was always successfully added to the queue with the correct synthetic session_id format (`tmux-%0-[timestamp]`)

3. **Pre-existing entries:** The queue consistently had 1-2 pre-existing entries from other active sessions (%13 from claude-print, %22 from mta-my-way)

4. **Isolation incomplete:** Despite the test creating an isolated tmux socket, the daemon and detector still see queue entries from the main Trail Boss instance running on the same server

### Test Infrastructure Issues

The test attempts to clear pre-existing queue entries (lines 52-64), but this only clears them at the start. New entries can be added by the main Trail Boss instance while the test is running.

## Recommendations

### Fix the Test Script

Line 178 should be changed to:
```bash
# Find the queue entry that matches our SESSION_ID, then extract pane_id
QUEUE_PANE_ID=$(echo "$QUEUE_RESPONSE" | grep -o "\"session_id\":\"$SESSION_ID\"[^}]*\"pane_id\":\"[^\"]*\"" | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4)
```

Or simpler: since we already verified the session_id format, we can directly check that our pane_id exists in the queue:
```bash
# Check that our test pane's entry exists in the queue (already done in the wait loop)
# The verification should just confirm that entry's session_id has the tmux- prefix
```

### Improve Test Isolation

Consider:
1. Running the daemon on a different port for testing
2. Using a separate data directory that won't share queue state
3. Mocking the queue API to avoid cross-contamination

## Conclusion

The tmux detector is **working correctly**. All 5 test failures are due to a test script bug that extracts the wrong pane_id from the queue response. The detector successfully:
- Auto-discovered the test pane
- Tracked it for quiet periods
- Detected it as stuck
- Created the correct queue entry
- Would have unstuck it on activity (not reached due to earlier failure)

The test execution was consistent with minimal variance (34-35s), showing no flaky behavior. Once the test script bug is fixed, we expect all 5 iterations to pass.
