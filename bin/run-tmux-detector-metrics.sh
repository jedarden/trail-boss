#!/bin/bash
# Automated test execution script for tmux detector acceptance testing
# Runs the acceptance test repeatedly and captures structured results

set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_SCRIPT="$TB_DIR/test-tmux-detector.sh"
RESULTS_DIR="$TB_DIR/test-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
RESULTS_FILE="$RESULTS_DIR/tmux-detector-metrics-$TIMESTAMP.csv"
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
      echo "  -o, --output FILE   Output results file (default: test-results/tmux-detector-metrics-YYYYMMDD-HHMMSS.csv)"
      echo "  -h, --help          Show this help message"
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

echo "=== Tmux Detector Acceptance Test Metrics ==="
echo "Running test $NUM_RUNS times..."
echo "Test script: $TEST_SCRIPT"
echo "Results file: $RESULTS_FILE"
echo ""

# Write CSV header
echo "run_number,status,exit_code,duration_seconds,notes" > "$RESULTS_FILE"

# Track overall statistics
total_pass=0
total_fail=0
total_duration=0

for run in $(seq 1 $NUM_RUNS); do
  echo "=== Run $run of $NUM_RUNS ==="

  start_time=$(date +%s)
  log_file="/tmp/tmux-detector-metrics-run-$run-$TIMESTAMP.log"

  # Run the test and capture output
  if bash "$TEST_SCRIPT" > "$log_file" 2>&1; then
    exit_code=0
    status="PASS"
    notes="Test completed successfully"
    total_pass=$((total_pass + 1))
  else
    exit_code=$?
    status="FAIL"
    total_fail=$((total_fail + 1))

    # Analyze failure pattern from log
    if grep -q "Pane was not detected as stuck" "$log_file" 2>/dev/null; then
      notes="False negative: pane not detected as stuck within timeout"
    elif grep -q "Session was not unstuck" "$log_file" 2>/dev/null; then
      notes="Dequeue failure: session not unstuck after activity"
    elif grep -q "daemon failed to start" "$log_file" 2>/dev/null; then
      notes="Infrastructure: daemon failed to start"
    elif grep -q "detector failed to start" "$log_file" 2>/dev/null; then
      notes="Infrastructure: detector failed to start"
    elif grep -q "Failed to set pane title" "$log_file" 2>/dev/null; then
      notes="Infrastructure: tmux pane configuration failed"
    elif grep -q "Queue should be empty" "$log_file" 2>/dev/null; then
      notes="State inconsistency: queue not empty after dequeue"
    else
      notes="Unknown failure - exit code $exit_code"
    fi
  fi

  end_time=$(date +%s)
  duration=$((end_time - start_time))
  total_duration=$((total_duration + duration))

  # Write to CSV
  echo "$run,$status,$exit_code,$duration,\"$notes\"" >> "$RESULTS_FILE"

  # Print result
  echo "Result: $status (exit code: $exit_code, duration: ${duration}s)"
  echo "Notes: $notes"
  echo "Log saved to: $log_file"
  echo ""

  # Small delay between runs to ensure clean state
  sleep 2
done

# Calculate and print summary
echo "=== Test Run Summary ==="
echo "Total runs: $NUM_RUNS"
echo "Passed: $total_pass"
echo "Failed: $total_fail"
echo "Success rate: $(awk "BEGIN {printf \"%.1f\", ($total_pass/$NUM_RUNS)*100}")%"
echo "Average duration: $(awk "BEGIN {printf \"%.1f\", $total_duration/$NUM_RUNS}")s"
echo "Total duration: ${total_duration}s"
echo ""
echo "Results saved to: $RESULTS_FILE"
echo ""
echo "CSV Preview:"
cat "$RESULTS_FILE"

# Return exit code based on whether all tests passed
if [ $total_fail -eq 0 ]; then
  exit 0
else
  exit 1
fi
