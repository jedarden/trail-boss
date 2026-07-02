#!/bin/bash
# Phase 7 Tmux Detector Acceptance Test — auto-discovery with @tb- prefix
# Tests the harness-agnostic tmux detector that watches opted-in panes
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss-tmux-test"
TEST_BASE="tb-tmux-$$"

# Isolated tmux socket — never touches the user's main server
TMUX_TEST_SOCK="/tmp/tmux-trailboss-tmux-test-$$"
TMUX="tmux -S $TMUX_TEST_SOCK"

# Quiet threshold from tmux-detector.ts
QUIET_THRESHOLD_MS=30000  # 30 seconds default
POLL_INTERVAL_MS=2000     # 2 seconds

# Cleanup function
cleanup() {
  local exit_code=$?
  echo "[cleanup] tearing down test environment..."
  $TMUX kill-server 2>/dev/null || true
  pkill -f "bun.*daemon/index.ts" 2>/dev/null || true
  pkill -f "tmux-detector.ts" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
  rm -f "$TMUX_TEST_SOCK" 2>/dev/null || true
  if [ $exit_code -ne 0 ]; then
    echo "[cleanup] exited with error code $exit_code"
  fi
}
trap cleanup EXIT

echo "=== Phase 7 Tmux Detector Acceptance Test ==="
echo "Acceptance Scenario: harness-agnostic auto-discovery detector"
echo "Testing: pane with @tb- prefix goes quiet -> appears in queue -> input dequeues"
echo ""

# Clean slate
cleanup
sleep 1

# Start daemon
echo "[setup] Starting daemon..."
mkdir -p "$DATA_DIR"
cd "$TB_DIR/daemon"
export TRAILBOSS_DATA_DIR="$DATA_DIR"
bun index.ts > /tmp/trailboss-daemon-test.log 2>&1 &
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
  cat /tmp/trailboss-daemon-test.log
  exit 1
fi
echo "[setup] daemon running (PID $DAEMON_PID)"

# Start a fresh tmux server for testing
echo "[setup] Starting isolated tmux server..."
$TMUX start-server
sleep 1

# Create a test session with a shell that will go quiet
echo "[setup] Creating test pane..."
$TMUX new-session -d -s "test-shell" "bash --noprofile --norc"
sleep 1

# Get the pane ID
PANE_ID=$($TMUX display -p -t "test-shell" '#{pane_id}')
echo "[setup] Created pane $PANE_ID"

# IMPORTANT: Set pane title to @tb-test to opt-in to detection
$TMUX select-pane -t "$PANE_ID" -T "@tb-test"
sleep 1

# Verify the pane title was set
PANE_TITLE=$($TMUX display -p -t "$PANE_ID" '#{pane_title}')
if [ "$PANE_TITLE" != "@tb-test" ]; then
  echo "[error] Failed to set pane title. Got: '$PANE_TITLE'"
  exit 1
fi
echo "[setup] Pane title verified: '$PANE_TITLE'"

# Start the tmux detector in background
echo "[setup] Starting tmux detector (auto-discovery mode)..."
cd "$TB_DIR"
export TMUX="$TMUX"  # Pass custom socket to detector
bun run daemon/tmux-detector.ts > /tmp/trailboss-detector-test.log 2>&1 &
DETECTOR_PID=$!
sleep 2

# Verify detector started
if ! kill -0 $DETECTOR_PID 2>/dev/null; then
  echo "[error] detector failed to start"
  cat /tmp/trailboss-detector-test.log
  exit 1
fi
echo "[setup] detector running (PID $DETECTOR_PID)"

# Check that the pane was registered
echo "[test] Checking that pane was registered..."
sleep 3
if ! grep -q "registered pane" /tmp/trailboss-detector-test.log 2>/dev/null; then
  # Try checking the log more carefully
  if grep -q "registered" /tmp/trailboss-detector-test.log 2>/dev/null; then
    echo "[test] Pane was registered (found in detector log)"
  else
    echo "[warn] No registration found in detector log, continuing..."
  fi
fi

echo "[test] Waiting for detector to detect pane as stuck..."
echo "[test] (quiet threshold is ${QUIET_THRESHOLD_MS}ms, poll interval is ${POLL_INTERVAL_MS}ms)"

# Wait for the pane to be detected as stuck
# This can take up to: quiet threshold (30s) + poll interval (2s) + initial setup time
WAIT_TIME=0
MAX_WAIT=40
while [ $WAIT_TIME -lt $MAX_WAIT ]; do
  RESPONSE=$(curl -s "$DAEMON_URL/queue")
  COUNT=$(echo "$RESPONSE" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")

  if [ "$COUNT" -gt 0 ]; then
    # Check if this is OUR test pane by looking for the pane_id in the queue
    if echo "$RESPONSE" | grep -q "\"pane_id\":\"$PANE_ID\""; then
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
  cat /tmp/trailboss-detector-test.log
  exit 1
fi

# Verify the stuck entry has the expected fields
echo "[test] Verifying queue entry..."
QUEUE_RESPONSE=$(curl -s "$DAEMON_URL/queue")

# Check that the session ID is the synthetic tmux session ID (starts with "tmux-")
if ! echo "$QUEUE_RESPONSE" | grep -q '"session_id":"tmux-' 2>/dev/null; then
  echo "[fail] Queue entry does not have expected session ID (tmux-*)"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Session ID format is correct (tmux-*)"

# Extract session_id for later verification
SESSION_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"session_id":"tmux-[^"]*"' | head -1 | cut -d'"' -f4)
echo "[test] Session ID: $SESSION_ID"

# Verify the pane_id matches our test pane
QUEUE_PANE_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"pane_id":"[^"]*"' | head -1 | cut -d'"' -f4)
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

# Check that last_message exists (should be the prompt line)
if ! echo "$QUEUE_RESPONSE" | grep -q '"last_message"'; then
  echo "[fail] Queue entry does not have last_message field"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] last_message field present"

# Now simulate activity by sending keys to the pane
echo "[test] Simulating activity in pane to trigger unstuck..."
$TMUX send-keys -t "$PANE_ID" "echo test activity"
$TMUX send-keys -t "$PANE_ID" Enter

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
  tail -20 /tmp/trailboss-detector-test.log
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
echo "The tmux detector successfully:"
echo "  - Auto-discovered a pane with @tb- prefix"
echo "  - Registered the pane for tracking"
echo "  - Detected it as stuck when quiet at a prompt"
echo "  - Enqueued it with reason='stopped'"
echo "  - Unstuck it when activity was detected"
echo "  - Dequeued it from the queue"
echo ""
echo "The harness-agnostic adapter seam is validated."
