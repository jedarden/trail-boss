# Tmux Detector Acceptance Test - 5 Iteration Run

**Execution Date:** 2026-07-02  
**Bead:** tb-43u1  
**Purpose:** Execute 5 iterations of acceptance test to collect raw data

## Execution Summary

| Metric | Value |
|--------|-------|
| Total iterations | 5 |
| Completed | 5 (100%) |
| Passed | 0 |
| Failed | 5 |
| Crashes/Hangs | 0 |
| Avg duration | 34.8s |
| Min duration | 34s |
| Max duration | 35s |

## Raw Results

All 5 runs failed with identical systematic failure:

```
Queue pane_id (%22) doesn't match test pane (%0)
```

### Per-Run Details

| Run | Result | Duration | Detection Time | Exit Code | Failure Type |
|-----|--------|----------|----------------|-----------|--------------|
| 1   | fail   | 35s      | 21s            | 1         | pane_id_mismatch |
| 2   | fail   | 34s      | 21s            | 1         | pane_id_mismatch |
| 3   | fail   | 35s      | 22s            | 1         | pane_id_mismatch |
| 4   | fail   | 35s      | 21s            | 1         | pane_id_mismatch |
| 5   | fail   | 35s      | 22s            | 1         | pane_id_mismatch |

## Key Findings

### Systematic Bug Identified
- **Detector is detecting wrong pane**: Test creates pane `%0` but queue contains pane `%22`
- **Detection works**: Pane was successfully detected as stuck (21-22s, consistent across runs)
- **Queueing bug**: Wrong pane_id is being added to the queue

### Execution Anomalies
- **None**: All iterations completed without crashes, hangs, or timeouts
- Consistent detection timing (21-22s) indicates stable detector behavior
- All iterations ran to completion with proper cleanup

## Artifacts

- **JSON results:** `test-results/tmux-detector-metrics-1783029759.json`
- **Individual logs:** `test-results/run-1.log` through `test-results/run-5.log`

## Analysis Notes

The detector is functioning (it detects stuck panes within the expected time), but there's a systematic bug where it's detecting or queuing the wrong pane. The test creates pane `%0` in an isolated tmux server, but the queue ends up with pane `%22`.

Possible causes to investigate:
1. Detector is scanning the wrong tmux server (not the isolated test server)
2. Pane ID parsing/transformation bug in the detector
3. Multiple tmux sessions exist and detector picks the wrong one

## Next Steps

1. Investigate why detector is seeing pane %22 instead of %0
2. Verify detector is connecting to the isolated tmux server socket
3. Check detector logic for pane ID extraction
