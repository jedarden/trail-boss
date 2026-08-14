#!/bin/bash
# Run tmux detector acceptance test 5 times and gather metrics

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULTS_FILE="$TB_DIR/test-results/tmux-detector-metrics-$(date +%s).json"
mkdir -p "$TB_DIR/test-results"

echo "Running tmux detector acceptance test 5 times..."
echo ""

# Initialize results JSON
echo '{"runs":[]}' > "$RESULTS_FILE"

for i in {1..5}; do
  echo "=== Run $i/5 ==="
  START_TIME=$(date +%s)

  # Run the test
  if $TB_DIR/test-tmux-detector.sh > "$TB_DIR/test-results/run-$i.log" 2>&1; then
    RESULT="pass"
    EXIT_CODE=0
  else
    RESULT="fail"
    EXIT_CODE=$?
  fi

  END_TIME=$(date +%s)
  DURATION=$((END_TIME - START_TIME))

  echo "Result: $RESULT (${DURATION}s)"
  echo ""

  # Extract details from the log
  LOG_FILE="$TB_DIR/test-results/run-$i.log"

  # Check for false positives (queue not empty at end when it should be)
  if grep -q "Queue should be empty" "$LOG_FILE" 2>/dev/null; then
    FALSE_POSITIVE="true"
  else
    FALSE_POSITIVE="false"
  fi

  # Check for false negatives (pane not detected when it should be)
  if grep -q "Pane was not detected as stuck" "$LOG_FILE" 2>/dev/null; then
    FALSE_NEGATIVE="true"
  else
    FALSE_NEGATIVE="false"
  fi

  # Check for other failures
  if grep -q "daemon failed to start" "$LOG_FILE" 2>/dev/null; then
    FAILURE_TYPE="daemon_start"
  elif grep -q "detector failed to start" "$LOG_FILE" 2>/dev/null; then
    FAILURE_TYPE="detector_start"
  elif grep -q "Failed to set pane title" "$LOG_FILE" 2>/dev/null; then
    FAILURE_TYPE="pane_title"
  elif grep -q "Pane was not detected as stuck" "$LOG_FILE" 2>/dev/null; then
    FAILURE_TYPE="detection_timeout"
  elif grep -q "Session was not unstuck" "$LOG_FILE" 2>/dev/null; then
    FAILURE_TYPE="unstuck_timeout"
  elif [ "$EXIT_CODE" -eq 0 ]; then
    FAILURE_TYPE="none"
  else
    FAILURE_TYPE="unknown"
  fi

  # Add to results
  RUN_JSON=$(cat <<EOF
{
  "run": $i,
  "result": "$RESULT",
  "duration_seconds": $DURATION,
  "exit_code": $EXIT_CODE,
  "false_positive": $FALSE_POSITIVE,
  "false_negative": $FALSE_NEGATIVE,
  "failure_type": "$FAILURE_TYPE",
  "log_file": "run-$i.log"
}
EOF
)

  # Append to results using jq
  if command -v jq >/dev/null 2>&1; then
    jq --argjson new "$RUN_JSON" '.runs += [$new]' "$RESULTS_FILE" > "$RESULTS_FILE.tmp" && mv "$RESULTS_FILE.tmp" "$RESULTS_FILE"
  else
    # Fallback without jq - simple append
    echo "$RUN_JSON" >> "$RESULTS_FILE.runs"
  fi

  # Cool down between runs
  sleep 2
done

echo ""
echo "=== Test run complete ==="
echo "Results saved to: $RESULTS_FILE"

# Print summary
if command -v jq >/dev/null 2>&1; then
  echo ""
  echo "Summary:"
  jq -r '.runs | "Total: \(length) | Pass: \([.[] | select(.result == \"pass\")] | length) | Fail: \([.[] | select(.result == \"fail\")] | length)"' "$RESULTS_FILE"
  echo ""
  echo "Duration stats:"
  jq -r '.runs | "Min: \([.[].duration_seconds] | min)s | Max: \([.[].duration_seconds] | max)s | Avg: \([.[].duration_seconds] | add / length | floor)s"' "$RESULTS_FILE"
  echo ""
  echo "False positives: \([.[] | select(.false_positive == true)] | length)"
  echo "False negatives: \([.[] | select(.false_negative == true)] | length)"
  echo ""
  echo "Failure types:"
  jq -r '.runs | group_by(.failure_type) | .[] | "\(.[0].failure_type): \(length)"' "$RESULTS_FILE"
fi

exit 0
