# Bead tb-1de3: Test Execution Results

## Task Execution

Executed 5 iterations of the tmux detector acceptance test using `run-tmux-detector-metrics.sh`.

## Results Summary

**All 5 runs completed** but failed due to a test design issue, not detector failure.

### Key Findings

1. **Detector is working correctly**: In every run, the detector successfully unstucks the test pane within 2 seconds of activity simulation
   - Run 1: unstuck at 21:00:08 (2s after activity)
   - Run 2: unstuck at 21:01:05 (2s after activity)
   - Run 3: unstuck at 21:02:03 (2s after activity)
   - Run 4: unstuck at 21:03:00 (2s after activity)
   - Run 5: unstuck at 21:03:57 (2s after activity)

2. **Test execution times were consistent**: 54-56 seconds per run (avg 55s)

3. **Test design flaw identified**: The test checks if the **entire queue is empty** (`COUNT -eq 0`) rather than checking if the **specific test session was removed** from the queue. The queue contains other entries from the user's real tmux sessions that get added during the 55-second test run.

4. **Failure pattern**: All 5 runs failed with "unstuck_timeout" - the test waits 15 seconds for the queue to become empty, but it never does because other queue entries exist.

### Evidence

From run-1.log detector logs:
```
[2026-07-02T21:00:08.352Z] [detector] unstuck: tmux-%0-1783025975785 (output changed)
[2026-07-02T21:00:08.352Z] [detector] poll: 1 panes tracked, 0 stuck
```

The detector clearly unstuck the pane and shows "0 stuck" afterwards - correct behavior.

### Root Cause

The test's queue isolation at setup (lines 52-64 of test-tmux-detector.sh) clears pre-existing entries, but new entries are added **during** the test run from the user's real tmux sessions going quiet. The test then fails because it expects `COUNT -eq 0` instead of checking if the specific test session_id was removed.

### Recommendation

The test should be fixed to:
1. Check specifically that the test session_id was removed from the queue
2. Not require the entire queue to be empty
3. Better isolate the test from real queue entries (perhaps by using a test-specific data directory)

## Raw Results

Results file: `test-results/tmux-detector-metrics-1783025966.json`

```json
{
  "runs": [
    {"run": 1, "result": "fail", "duration_seconds": 55, "failure_type": "unstuck_timeout"},
    {"run": 2, "result": "fail", "duration_seconds": 56, "failure_type": "unstuck_timeout"},
    {"run": 3, "result": "fail", "duration_seconds": 56, "failure_type": "unstuck_timeout"},
    {"run": 4, "result": "fail", "duration_seconds": 55, "failure_type": "unstuck_timeout"},
    {"run": 5, "result": "fail", "duration_seconds": 54, "failure_type": "unstuck_timeout"}
  ]
}
```

## Conclusion

The **detector is functioning correctly** - it successfully detects stuck panes and unstucks them when activity resumes. The test failures are due to a test design issue that doesn't properly isolate queue state during execution.
