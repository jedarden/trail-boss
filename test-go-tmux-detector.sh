#!/bin/bash
# Phase 7 Tmux Detector Adapter Acceptance Test (Go-based)
# Tests the Go tmux detector that watches opted-in panes via @trailboss-monitor option
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss-go-tmux-test"
TEST_BASE="tb-go-tmux-$$"

# Use main tmux server with unique session names
# Keep the existing TMUX environment variable for socket access
TEST_SESSION="tb-test-detect-$$"

# Go detector constants from types.go
POLL_INTERVAL_MS=2000       # 2 seconds
STUCK_THRESHOLD_MS=10000    # 10 seconds

# Cleanup function
cleanup() {
  local exit_code=$?
  echo "[cleanup] tearing down test environment..."
  # Kill our test session
  tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
  pkill -f "bun.*daemon/index.ts" 2>/dev/null || true
  pkill -f "tmux-detector-test" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
  if [ $exit_code -ne 0 ]; then
    echo "[cleanup] exited with error code $exit_code"
  fi
}
trap cleanup EXIT

echo "=== Phase 7 Tmux Detector Adapter Acceptance Test (Go-based) ==="
echo "Acceptance Scenario: Go-based tmux detector with @trailboss-monitor option"
echo "Testing: pane with @trailboss-monitor=1 goes quiet -> appears in queue -> input dequeues"
echo ""

# Clean slate
cleanup
sleep 1

# Start daemon
echo "[setup] Starting daemon..."
mkdir -p "$DATA_DIR"
cd "$TB_DIR/daemon"
export TRAILBOSS_DATA_DIR="$DATA_DIR"
bun index.ts > /tmp/trailboss-daemon-go-test.log 2>&1 &
DAEMON_PID=$!
sleep 2

# Clear any pre-existing queue entries to ensure test isolation
echo "[setup] Clearing pre-existing queue entries..."
while true; do
  QUEUE_CHECK=$(curl -s "$DAEMON_URL/queue")
  COUNT=$(echo "$QUEUE_CHECK" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")
  if [ "$COUNT" -eq 0 ]; then
    echo "[setup] Queue is clean"
    break
  fi
  echo "[setup] Skipping pre-existing queue entry..."
  curl -s -X POST "$DAEMON_URL/skip" >/dev/null
  sleep 0.5
done

# Verify daemon started
if ! curl -s --max-time 1 "$DAEMON_URL/status" >/dev/null 2>&1; then
  echo "[error] daemon failed to start"
  cat /tmp/trailboss-daemon-go-test.log
  exit 1
fi
echo "[setup] daemon running (PID $DAEMON_PID)"

# Create a test session with a shell that will go quiet
echo "[setup] Creating test pane on main tmux server..."
tmux new-session -d -s "$TEST_SESSION" "bash --noprofile --norc"
sleep 1

# Get the pane ID
PANE_ID=$(tmux display -p -t "$TEST_SESSION" '#{pane_id}')
echo "[setup] Created pane $PANE_ID in session $TEST_SESSION"

# IMPORTANT: Set @trailboss-monitor option to 1 to opt-in to detection
tmux set-option -p -t "$PANE_ID" "@trailboss-monitor" "1"
sleep 1

# Verify the option was set
MONITOR_OPTION=$(tmux display -p -t "$PANE_ID" '#{@trailboss-monitor}')
if [ "$MONITOR_OPTION" != "1" ]; then
  echo "[error] Failed to set @trailboss-monitor option. Got: '$MONITOR_OPTION'"
  exit 1
fi
echo "[setup] @trailboss-monitor option verified: '$MONITOR_OPTION'"

# Build and start the Go tmux detector in background
echo "[setup] Building Go tmux detector..."
cd "$TB_DIR/daemon/tmux-adapter"
go build -o /tmp/tmux-detector-test . 2>&1
if [ ! -f /tmp/tmux-detector-test ]; then
  echo "[error] Failed to build Go detector"
  exit 1
fi

echo "[setup] Starting Go tmux detector (option-based mode)..."
# The detector needs access to the tmux socket - inherit full shell environment
/tmp/tmux-detector-test > /tmp/trailboss-go-detector-test.log 2>&1 &
DETECTOR_PID=$!
sleep 2

# Verify detector started
if ! kill -0 $DETECTOR_PID 2>/dev/null; then
  echo "[error] detector failed to start"
  cat /tmp/trailboss-go-detector-test.log
  exit 1
fi
echo "[setup] detector running (PID $DETECTOR_PID)"

# Check that the pane was registered
echo "[test] Checking that pane was registered..."
sleep 3
if ! grep -q "registered" /tmp/trailboss-go-detector-test.log 2>/dev/null; then
  # Try checking the log more carefully
  if grep -q "registered pane" /tmp/trailboss-go-detector-test.log 2>/dev/null; then
    echo "[test] Pane was registered (found in detector log)"
  else
    echo "[warn] No registration found in detector log, continuing..."
  fi
fi

echo "[test] Waiting for detector to detect pane as stuck..."
echo "[test] (stuck threshold is ${STUCK_THRESHOLD_MS}ms, poll interval is ${POLL_INTERVAL_MS}ms)"

# Wait for the pane to be detected as stuck
# This can take up to: stuck threshold (10s) + poll interval (2s) + initial setup time
WAIT_TIME=0
MAX_WAIT=20
while [ $WAIT_TIME -lt $MAX_WAIT ]; do
  RESPONSE=$(curl -s "$DAEMON_URL/queue")
  COUNT=$(echo "$RESPONSE" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")

  if [ "$COUNT" -gt 0 ]; then
    # Check if this is OUR test pane by looking for the pane_id in the queue
    if echo "$RESPONSE" | grep -q "\"paneId\":\"$PANE_ID\""; then
      echo "[test] Pane detected as stuck after ${WAIT_TIME}s"
      break
    else
      echo "[debug] Queue has $COUNT entries but none match test pane $PANE_ID"
    fi
  fi

  sleep 1
  WAIT_TIME=$((WAIT_TIME + 1))
done

if [ $WAIT_TIME -ge $MAX_WAIT ]; then
  echo "[fail] Pane was not detected as stuck within ${MAX_WAIT}s"
  echo "[info] Queue response: $(curl -s "$DAEMON_URL/queue")"
  echo "[info] Detector log:"
  cat /tmp/trailboss-go-detector-test.log
  exit 1
fi

# Verify the stuck entry has the expected fields
echo "[test] Verifying queue entry..."
QUEUE_RESPONSE=$(curl -s "$DAEMON_URL/queue")

# Check that the session ID is the synthetic tmux session ID (starts with "tmux-")
if ! echo "$QUEUE_RESPONSE" | grep -q '"sessionId":"tmux-' 2>/dev/null; then
  echo "[fail] Queue entry does not have expected session ID (tmux-*)"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Session ID format is correct (tmux-*)"

# Extract session_id for later verification
SESSION_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"sessionId":"tmux-[^"]*"' | head -1 | cut -d'"' -f4)
echo "[test] Session ID: $SESSION_ID"

# Verify the pane_id matches our test pane (note: JSON field is paneId, not pane_id)
QUEUE_PANE_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"paneId":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$QUEUE_PANE_ID" != "$PANE_ID" ]; then
  echo "[fail] Queue pane_id ($QUEUE_PANE_ID) doesn't match test pane ($PANE_ID)"
  exit 1
fi
echo "[test] Pane ID matches: $PANE_ID"

# Check that the reason is "stopped"
if ! echo "$QUEUE_RESPONSE" | grep -q '"reason":"stopped"'; then
  echo "[fail] Queue entry does not have reason=stopped"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Reason is correct: stopped"

# Check that message exists (should be the prompt line)
if ! echo "$QUEUE_RESPONSE" | grep -q '"message"'; then
  echo "[fail] Queue entry does not have message field"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] message field present"

# Now simulate activity by sending keys to the pane
echo "[test] Simulating activity in pane to trigger unstuck..."
tmux send-keys -t "$PANE_ID" "echo test activity"
tmux send-keys -t "$PANE_ID" Enter

# Wait for the detector to notice and unstuck the session
echo "[test] Waiting for detector to unstuck session..."
WAIT_TIME=0
MAX_WAIT=15
while [ $WAIT_TIME -lt $MAX_WAIT ]; do
  RESPONSE=$(curl -s "$DAEMON_URL/queue")
  COUNT=$(echo "$RESPONSE" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")

  if [ "$COUNT" -eq 0 ]; then
    echo "[test] Session unstuck after ${WAIT_TIME}s"
    break
  fi

  sleep 1
  WAIT_TIME=$((WAIT_TIME + 1))
done

if [ $WAIT_TIME -ge $MAX_WAIT ]; then
  echo "[fail] Session was not unstuck within ${MAX_WAIT}s"
  echo "[info] Queue response: $(curl -s "$DAEMON_URL/queue")"
  echo "[info] Detector log:"
  tail -20 /tmp/trailboss-go-detector-test.log
  exit 1
fi

# Final verification: session should be gone from queue
echo "[test] Final verification: queue is empty"
FINAL_RESPONSE=$(curl -s "$DAEMON_URL/queue")
FINAL_COUNT=$(echo "$FINAL_RESPONSE" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")
if [ "$FINAL_COUNT" -ne 0 ]; then
  echo "[fail] Queue should be empty but has $FINAL_COUNT items"
  echo "[debug] Queue: $FINAL_RESPONSE"
  exit 1
fi
echo "[test] Queue is empty - session successfully dequeued"

echo ""
echo "=== PASS ==="
echo "The Go tmux detector successfully:"
echo "  - Auto-discovered a pane with @trailboss-monitor=1"
echo "  - Registered the pane for tracking"
echo "  - Detected it as stuck when quiet at a prompt"
echo "  - Enqueued it with reason='stopped'"
echo "  - Unstuck it when activity was detected"
echo "  - Dequeued it from the queue"
echo ""
echo "The harness-agnostic adapter seam (Go implementation) is validated."
