#!/bin/bash
# Automated acceptance test execution script for tmux detector
# Runs the acceptance test 5 times and captures structured metrics
# Output format: JSON (parseable for analysis)

set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_SCRIPT="$TB_DIR/test-tmux-detector.sh"
RESULTS_DIR="$TB_DIR/test-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_FILE="$RESULTS_DIR/tmux-detector-acceptance-$TIMESTAMP.json"
NUM_RUNS=5

# Parse command line arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -n|--num-runs)
      NUM_RUNS="$2"
      shift 2
      ;;
    -o|--output)
      RESULTS_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  -n, --num-runs N    Number of test iterations (default: 5)"
      echo "  -o, --output FILE   Output results file (default: test-results/tmux-detector-acceptance-YYYYMMDD-HHMMSS.json)"
      echo "  -h, --help          Show this help message"
      echo ""
      echo "Output format: JSON with per-run metrics including:"
      echo "  - timestamp, run_number, result (pass/fail)"
      echo "  - duration_seconds, exit_code"
      echo "  - false_positive, false_negative (detected from logs)"
      echo "  - failure_type, error_message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Validate inputs
if ! [[ "$NUM_RUNS" =~ ^[0-9]+$ ]] || [ "$NUM_RUNS" -lt 1 ]; then
  echo "Error: num-runs must be a positive integer"
  exit 1
fi

# Verify test script exists
if [ ! -f "$TEST_SCRIPT" ]; then
  echo "Error: Test script not found: $TEST_SCRIPT"
  exit 1
fi

# Create results directory
mkdir -p "$RESULTS_DIR"

echo "=== Tmux Detector Acceptance Test Execution ==="
echo "Running test $NUM_RUNS times..."
echo "Test script: $TEST_SCRIPT"
echo "Results file: $RESULTS_FILE"
echo ""

# Initialize results JSON
cat > "$RESULTS_FILE" <<EOF
{
  "test_name": "tmux-detector-acceptance",
  "timestamp": "$TIMESTAMP",
  "num_runs": $NUM_RUNS,
  "runs": []
}
EOF

# Track overall statistics
total_pass=0
total_fail=0
total_duration=0

for run in $(seq 1 $NUM_RUNS); do
  echo "=== Run $run of $NUM_RUNS ==="

  start_time=$(date +%s)
  run_timestamp=$(date -Iseconds)
  log_file="$RESULTS_DIR/tmux-detector-run${TIMESTAMP}-${run}.log"

  # Run the test and capture output
  if bash "$TEST_SCRIPT" > "$log_file" 2>&1; then
    exit_code=0
    result="pass"
    total_pass=$((total_pass + 1))
    failure_type="none"
    error_message=""
  else
    exit_code=$?
    result="fail"
    total_fail=$((total_fail + 1))

    # Analyze failure pattern from log for false positives/negatives
    if grep -q "Pane was not detected as stuck" "$log_file" 2>/dev/null; then
      failure_type="detection_timeout"
      error_message="False negative: pane not detected as stuck within timeout"
    elif grep -q "Session was not unstuck" "$log_file" 2>/dev/null; then
      failure_type="unstuck_timeout"
      error_message="Dequeue failure: session not unstuck after activity"
    elif grep -q "daemon failed to start" "$log_file" 2>/dev/null; then
      failure_type="daemon_start"
      error_message="Infrastructure: daemon failed to start"
    elif grep -q "detector failed to start" "$log_file" 2>/dev/null; then
      failure_type="detector_start"
      error_message="Infrastructure: detector failed to start"
    elif grep -q "Failed to set pane title" "$log_file" 2>/dev/null; then
      failure_type="pane_title"
      error_message="Infrastructure: tmux pane configuration failed"
    elif grep -q "Queue should be empty" "$log_file" 2>/dev/null; then
      failure_type="state_inconsistency"
      error_message="False positive: queue not empty after dequeue"
    else
      failure_type="unknown"
      error_message="Unknown failure - exit code $exit_code"
    fi
  fi

  end_time=$(date +%s)
  duration=$((end_time - start_time))
  total_duration=$((total_duration + duration))

  # Detect false positives (test passed but queue should have been empty)
  false_positive="false"
  if [ "$result" = "fail" ] && grep -q "Queue should be empty" "$log_file" 2>/dev/null; then
    false_positive="true"
  fi

  # Detect false negatives (pane not detected when it should be)
  false_negative="false"
  if [ "$result" = "fail" ] && grep -q "Pane was not detected as stuck" "$log_file" 2>/dev/null; then
    false_negative="true"
  fi

  # Print result
  echo "Result: $result (exit code: $exit_code, duration: ${duration}s)"
  echo "Failure type: $failure_type"
  echo "Error: $error_message"
  echo "False positive: $false_positive"
  echo "False negative: $false_negative"
  echo "Log saved to: $log_file"
  echo ""

  # Build run JSON
  run_json=$(cat <<EOF
  {
    "timestamp": "$run_timestamp",
    "run_number": $run,
    "result": "$result",
    "duration_seconds": $duration,
    "exit_code": $exit_code,
    "false_positive": $false_positive,
    "false_negative": $false_negative,
    "failure_type": "$failure_type",
    "error_message": "$error_message",
    "log_file": "$(basename "$log_file")"
  }
EOF
)

  # Append to results using jq (or fallback to simple append)
  if command -v jq >/dev/null 2>&1; then
    jq --argjson new "$run_json" '.runs += [$new]' "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
  else
    # Fallback: append manually
    # Remove closing bracket, append with comma, re-add closing bracket
    sed -i '$ s/],$//' "$RESULTS_FILE"
    sed -i '$ s/}$//' "$RESULTS_FILE"
    echo "  ,$run_json" >> "$RESULTS_FILE"
    echo "]}" >> "$RESULTS_FILE"
  fi

  # Small delay between runs to ensure clean state
  sleep 2
done

# Calculate and print summary
echo "=== Test Run Summary ==="
echo "Total runs: $NUM_RUNS"
echo "Passed: $total_pass"
echo "Failed: $total_fail"
success_rate=$(awk "BEGIN {printf \"%.1f\", ($total_pass/$NUM_RUNS)*100}")
echo "Success rate: ${success_rate}%"
avg_duration=$(awk "BEGIN {printf \"%.1f\", $total_duration/$NUM_RUNS}")
echo "Average duration: ${avg_duration}s"
echo "Total duration: ${total_duration}s"
echo ""

# Add summary to JSON
if command -v jq >/dev/null 2>&1; then
  # Build summary as a JSON string since jq doesn't handle bash variables well
  summary_json="{\"total_runs\":$NUM_RUNS,\"passed\":$total_pass,\"failed\":$total_fail,\"success_rate\":$success_rate,\"average_duration\":$avg_duration,\"total_duration\":$total_duration}"
  jq --argjson summary "$summary_json" '.summary = $summary' "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
fi

echo "Results saved to: $RESULTS_FILE"
echo ""

# Print JSON preview
echo "JSON Preview:"
if command -v jq >/dev/null 2>&1; then
  jq '.' "$RESULTS_FILE"
else
  cat "$RESULTS_FILE"
fi
echo ""

# Print detailed false positive/negative stats
echo "Quality Metrics:"
false_positive_count=$(grep -c '"false_positive": true' "$RESULTS_FILE" 2>/dev/null || echo "0")
false_negative_count=$(grep -c '"false_negative": true' "$RESULTS_FILE" 2>/dev/null || echo "0")
echo "False positives: $false_positive_count"
echo "False negatives: $false_negative_count"
echo ""

# Print failure type breakdown
echo "Failure Type Breakdown:"
if command -v jq >/dev/null 2>&1; then
  jq -r '.runs | group_by(.failure_type) | .[] | "  \(.[0].failure_type): \(length)"' "$RESULTS_FILE"
else
  grep -o '"failure_type": "[^"]*"' "$RESULTS_FILE" | sort | uniq -c | sed 's/^/  /'
fi
echo ""

# Return exit code based on whether all tests passed
if [ $total_fail -eq 0 ]; then
  echo "All tests PASSED!"
  exit 0
else
  echo "Some tests FAILED"
  exit 1
fi
