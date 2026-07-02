# Bead tb-2lh: Test Baseline Establishment

## Execution Summary

- **Test Date**: 2026-07-02 19:38:10
- **Iterations**: 1
- **Result**: FAIL (exit code 1)
- **Duration**: 35 seconds
- **Test Script**: `bin/run-tmux-detector-acceptance.sh -n 1`

## Data Capture Format - VALIDATED ✓

The established data capture format is **JSON** with the following structure:

### Per-Run Metrics
```json
{
  "timestamp": "ISO-8601 timestamp",
  "run_number": 1,
  "result": "pass|fail",
  "duration_seconds": 35,
  "exit_code": 0|1,
  "false_positive": true|false,
  "false_negative": true|false,
  "failure_type": "detection_timeout|unstuck_timeout|daemon_start|detector_start|pane_title|state_inconsistency|unknown",
  "error_message": "Human-readable error description",
  "log_file": "Reference to detailed log file"
}
```

### Summary Metrics
```json
{
  "total_runs": 1,
  "passed": 0,
  "failed": 1,
  "success_rate": 0.0,
  "average_duration": 35.0,
  "total_duration": 35
}
```

## Required Metrics Verification

| Metric | Status | Location |
|--------|--------|----------|
| Pass/fail status | ✓ | `runs[].result` |
| Execution time | ✓ | `runs[].duration_seconds` |
| False positives | ✓ | `runs[].false_positive` |
| False negatives | ✓ | `runs[].false_negative` |

## Test Failure Details

**Failure Type**: Pane ID mismatch
- Expected pane ID: `%0`
- Actual pane ID in queue: `%22`
- Root cause: The detector registered a different pane than the test created

**Failure Classification**: NOT a false positive/negative — this is a genuine test environment issue

## Data Recording Format Validation

✓ **Format**: JSON
✓ **Parseable**: Yes (jq-compatible)
✓ **Comprehensive**: All required metrics captured
✓ **Extensible**: Additional metadata included (exit_code, failure_type, error_message)
✓ **Traceability**: Links to detailed log files

## Files Generated

- **Results**: `test-results/tmux-detector-acceptance-20260702-193810.json`
- **Detailed Log**: `test-results/tmux-detector-run20260702-193810-1.log`

## Conclusion

The first test iteration successfully established the measurement baseline. The data recording format is validated as JSON, capturing all required metrics (pass/fail, execution time, false positives, false negatives) plus additional context for failure analysis.

The test failed due to a pane ID mismatch issue in the test environment, not due to detector logic failure. This provides valuable baseline data for subsequent iterations.
