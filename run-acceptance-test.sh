#!/bin/bash
# Run tmux detector acceptance test N times and collect metrics
set -e

TEST_SCRIPT="/home/coding/trail-boss/test-tmux-detector.sh"
RESULTS_FILE="/home/coding/trail-boss/test-results/tb-1me-results-$(date +%Y%m%d-%H%M%S).csv"
NUM_RUNS=5

echo "Running tmux detector acceptance test $NUM_RUNS times..."
echo "run_number,status,exit_code,duration_seconds,notes" > "$RESULTS_FILE"

for run in $(seq 1 $NUM_RUNS); do
  echo "=== Run $run of $NUM_RUNS ==="

  start_time=$(date +%s)

  # Run the test and capture output
  if bash "$TEST_SCRIPT" > "/tmp/tmux-test-run-$run.log" 2>&1; then
    exit_code=0
    status="PASS"
    notes="Test completed successfully"
  else
    exit_code=$?
    status="FAIL"
    # Check for specific failure patterns
    if grep -q "Pane was not detected as stuck" "/tmp/tmux-test-run-$run.log" 2>/dev/null; then
      notes="False negative: pane not detected as stuck"
    elif grep -q "Session was not unstuck" "/tmp/tmux-test-run-$run.log" 2>/dev/null; then
      notes="False negative: session not unstuck after activity"
    elif grep -q "daemon failed to start" "/tmp/tmux-test-run-$run.log" 2>/dev/null; then
      notes="Infrastructure: daemon failed to start"
    elif grep -q "detector failed to start" "/tmp/tmux-test-run-$run.log" 2>/dev/null; then
      notes="Infrastructure: detector failed to start"
    else
      notes="Unknown failure - check log file"
    fi
  fi

  end_time=$(date +%s)
  duration=$((end_time - start_time))

  echo "$run,$status,$exit_code,$duration,\"$notes\"" >> "$RESULTS_FILE"
  echo "Result: $status (exit code: $exit_code, duration: ${duration}s)"
  echo "Notes: $notes"
  echo ""

  # Small delay between runs to ensure clean state
  sleep 2
done

echo ""
echo "=== Test Run Summary ==="
echo "Results saved to: $RESULTS_FILE"
cat "$RESULTS_FILE" | column -t -s','
