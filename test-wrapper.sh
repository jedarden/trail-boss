#!/bin/bash
# Test runner wrapper for tmux detector acceptance test
# Captures output, timing, and exit status for automated execution

set -e

TEST_SCRIPT="./test-tmux-detector.sh"
OUTPUT_DIR="./test-results"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="$OUTPUT_DIR/tmux-detector-$TIMESTAMP.log"
SUMMARY_FILE="$OUTPUT_DIR/tmux-detector-$TIMESTAMP-summary.json"

# Create output directory if it doesn't exist
mkdir -p "$OUTPUT_DIR"

echo "=== Running tmux detector acceptance test ==="
echo "Output will be saved to: $OUTPUT_FILE"
echo ""

# Run the test and capture timing
START_TIME=$(date +%s)
if bash "$TEST_SCRIPT" > "$OUTPUT_FILE" 2>&1; then
  EXIT_CODE=0
  STATUS="pass"
else
  EXIT_CODE=$?
  STATUS="fail"
fi
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Print the output to console
cat "$OUTPUT_FILE"

# Create summary JSON
cat > "$SUMMARY_FILE" <<EOF
{
  "test": "tmux-detector-acceptance",
  "status": "$STATUS",
  "exit_code": $EXIT_CODE,
  "duration_seconds": $DURATION,
  "timestamp": "$TIMESTAMP",
  "output_file": "$OUTPUT_FILE"
}
EOF

echo ""
echo "=== Test Summary ==="
echo "Status: $STATUS"
echo "Exit code: $EXIT_CODE"
echo "Duration: ${DURATION}s"
echo "Output saved to: $OUTPUT_FILE"
echo "Summary saved to: $SUMMARY_FILE"

# Exit with the test's exit code
exit $EXIT_CODE
