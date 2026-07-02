#!/bin/bash
# Run tmux detector acceptance test N times and collect metrics for bead tb-43u1
set -e

TEST_SCRIPT="/home/coding/trail-boss/test-tmux-detector.sh"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_DIR="/home/coding/trail-boss/test-results/tb-43u1-${TIMESTAMP}"
RESULTS_FILE="${RESULTS_DIR}/results.csv"
NUM_RUNS=5

mkdir -p "$RESULTS_DIR"

echo "Running tmux detector acceptance test $NUM_RUNS times for bead tb-43u1..."
echo "Results directory: $RESULTS_DIR"
echo "run_number,status,exit_code,duration_seconds,notes" > "$RESULTS_FILE"

for run in $(seq 1 $NUM_RUNS); do
  echo "=== Run $run of $NUM_RUNS ==="

  start_time=$(date +%s)

  # Run the test and capture output
  if bash "$TEST_SCRIPT" > "${RESULTS_DIR}/run-${run}.log" 2>&1; then
    exit_code=0
    status="PASS"
    notes="Test completed successfully"
  else
    exit_code=$?
    status="FAIL"
    # Check for specific failure patterns
    if grep -q "Pane was not detected as stuck" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="False negative: pane not detected as stuck"
    elif grep -q "Pane ID.*doesn't match" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="Bug: pane ID mismatch in queue"
    elif grep -q "Session was not unstuck" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="False negative: session not unstuck after activity"
    elif grep -q "daemon failed to start" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="Infrastructure: daemon failed to start"
    elif grep -q "detector failed to start" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="Infrastructure: detector failed to start"
    elif grep -q "404 - Not found" "${RESULTS_DIR}/run-${run}.log" 2>/dev/null; then
      notes="Bug: daemon endpoint returned 404"
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
echo "Results directory: $RESULTS_DIR"
cat "$RESULTS_FILE" | column -t -s','
