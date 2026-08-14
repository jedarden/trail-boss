#!/bin/bash
# Phase 7 Tmux Detector Adapter Acceptance Test
# Tests the Go tmux detector with @trailboss-monitor option
# Tests full lifecycle: quiet -> stuck -> activity -> unstuck
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss-tmux-acceptance-test"
TEST_SESSION="tb-accept-test-$$"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

# Go detector constants
POLL_INTERVAL_MS=2000       # 2 seconds
STUCK_THRESHOLD_MS=10000    # 10 seconds

# Cleanup function
cleanup() {
  local exit_code=$?
  echo "[cleanup] tearing down test environment..."
  tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
  pkill -f "bun.*trail-boss/daemon/index.ts" 2>/dev/null || true
  pkill -f "tmux-detector-acceptance" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
  if [ $exit_code -ne 0 ]; then
    echo "[cleanup] exited with error code $exit_code"
  fi
}
trap cleanup EXIT

echo "=== Phase 7 Tmux Detector Adapter Acceptance Test ==="
echo "Acceptance Scenario: full detection lifecycle validation"
echo "Testing: @trailboss-monitor=1 -> quiet -> stuck -> activity -> unstuck"
echo ""

# Clean slate
cleanup
sleep 1

# Start daemon
echo "[setup] Starting daemon..."
mkdir -p "$DATA_DIR"
cd "$TB_DIR/daemon"
export TRAILBOSS_DATA_DIR="$DATA_DIR"
bun index.ts > "/tmp/trailboss-daemon-acceptance-$TIMESTAMP.log" 2>&1 &
DAEMON_PID=$!
sleep 2

# Verify daemon started
if ! curl -s --max-time 1 "$DAEMON_URL/status" >/dev/null 2>&1; then
  echo "[error] daemon failed to start"
  cat "/tmp/trailboss-daemon-acceptance-$TIMESTAMP.log"
  exit 1
fi
echo "[setup] daemon running (PID $DAEMON_PID)"

# Clear any pre-existing queue entries
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

# Create a test session
echo "[setup] Creating test pane..."
tmux new-session -d -s "$TEST_SESSION" "bash --noprofile --norc"
sleep 1

PANE_ID=$(tmux display -p -t "$TEST_SESSION" '#{pane_id}')
echo "[setup] Created pane $PANE_ID in session $TEST_SESSION"

# Set @trailboss-monitor option to opt-in to detection
tmux set-option -p -t "$PANE_ID" "@trailboss-monitor" "1"
sleep 1

# Verify the option was set
MONITOR_OPTION=$(tmux display -p -t "$PANE_ID" '#{@trailboss-monitor}')
if [ "$MONITOR_OPTION" != "1" ]; then
  echo "[error] Failed to set @trailboss-monitor. Got: '$MONITOR_OPTION'"
  exit 1
fi
echo "[setup] @trailboss-monitor option verified: '$MONITOR_OPTION'"

# Debug: verify the pane appears in list-panes output
echo "[setup] Verifying pane is discoverable..."
MONITORED_PANES=$(tmux list-panes -a -F "#{pane_id}:#{@trailboss-monitor}" | grep ":1$" | cut -d: -f1)
if echo "$MONITORED_PANES" | grep -q "$PANE_ID"; then
  echo "[setup] Pane $PANE_ID is in monitored list"
else
  echo "[error] Pane $PANE_ID not found in monitored list"
  echo "[debug] Monitored panes: $MONITORED_PANES"
  exit 1
fi

# Build and start the Go tmux detector
echo "[setup] Building Go tmux detector..."
cd "$TB_DIR/daemon/tmux-adapter"
go build -o "/tmp/tmux-detector-acceptance" . 2>&1
if [ ! -f "/tmp/tmux-detector-acceptance" ]; then
  echo "[error] Failed to build Go detector"
  exit 1
fi

echo "[setup] Starting Go tmux detector..."
"/tmp/tmux-detector-acceptance" > "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log" 2>&1 &
DETECTOR_PID=$!
sleep 2

# Verify detector started
if ! kill -0 $DETECTOR_PID 2>/dev/null; then
  echo "[error] detector failed to start"
  cat "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log"
  exit 1
fi
echo "[setup] detector running (PID $DETECTOR_PID)"

# Wait a moment for detector to discover the pane
echo "[test] Waiting for detector to discover and register pane..."
sleep 5

# Check detector log for registration
if grep -q "registered pane" "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log" 2>/dev/null; then
  echo "[test] Pane was registered"
else
  echo "[warn] No registration log found (detector may have logged differently)"
  echo "[debug] Detector log tail:"
  tail -5 "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log"
fi

echo "[test] Waiting for detector to detect pane as stuck..."
echo "[test] (stuck threshold is ${STUCK_THRESHOLD_MS}ms, poll interval is ${POLL_INTERVAL_MS}ms)"

# Wait for the pane to be detected as stuck
WAIT_TIME=0
MAX_WAIT=25
while [ $WAIT_TIME -lt $MAX_WAIT ]; do
  RESPONSE=$(curl -s "$DAEMON_URL/queue")
  COUNT=$(echo "$RESPONSE" | grep -o '"count":[0-9]*' | grep -o '[0-9]*' || echo "0")

  if [ "$COUNT" -gt 0 ]; then
    # Check if this is our test pane (Go detector uses camelCase: paneId)
    if echo "$RESPONSE" | grep -q "\"paneId\":\"$PANE_ID\""; then
      echo "[test] Pane detected as stuck after ${WAIT_TIME}s"
      break
    else
      echo "[debug] Queue has $COUNT entries but none match test pane $PANE_ID"
      # Log what's in the queue for debugging
      echo "[debug] Queue pane IDs: $(echo "$RESPONSE" | grep -o '"paneId":"[^"]*"' | cut -d'"' -f4 | head -3)"
    fi
  fi

  sleep 1
  WAIT_TIME=$((WAIT_TIME + 1))
done

if [ $WAIT_TIME -ge $MAX_WAIT ]; then
  echo "[fail] Pane was not detected as stuck within ${MAX_WAIT}s"
  echo "[info] Final queue response: $(curl -s "$DAEMON_URL/queue")"
  echo "[info] Detector log:"
  cat "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log"
  exit 1
fi

# Verify the stuck entry has the expected fields
echo "[test] Verifying queue entry..."
QUEUE_RESPONSE=$(curl -s "$DAEMON_URL/queue")

# Check session ID format (tmux-*)
if ! echo "$QUEUE_RESPONSE" | grep -q '"sessionId":"tmux-'; then
  echo "[fail] Session ID format incorrect (expected tmux-*)"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Session ID format is correct (tmux-*)"

# Verify pane_id matches
QUEUE_PANE_ID=$(echo "$QUEUE_RESPONSE" | grep -o '"paneId":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$QUEUE_PANE_ID" != "$PANE_ID" ]; then
  echo "[fail] Queue paneId ($QUEUE_PANE_ID) doesn't match test pane ($PANE_ID)"
  exit 1
fi
echo "[test] Pane ID matches: $PANE_ID"

# Check reason is "stopped"
if ! echo "$QUEUE_RESPONSE" | grep -q '"reason":"stopped"'; then
  echo "[fail] Reason is not 'stopped'"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Reason is correct: stopped"

# Check message exists
if ! echo "$QUEUE_RESPONSE" | grep -q '"message"'; then
  echo "[fail] Message field missing"
  echo "[debug] Queue: $QUEUE_RESPONSE"
  exit 1
fi
echo "[test] Message field present"

# Now simulate activity by sending keys to the pane
echo "[test] Simulating activity in pane to trigger unstuck..."
tmux send-keys -t "$PANE_ID" "echo 'trailboss test activity'"
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
  echo "[info] Detector log tail:"
  tail -10 "/tmp/trailboss-detector-acceptance-$TIMESTAMP.log"
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
echo "The tmux detector adapter successfully validated:"
echo "  ✓ Isolated tmux session with @trailboss-monitor=1"
echo "  ✓ Pane discovery and registration"
echo "  ✓ Detection of stuck state (quiet at prompt)"
echo "  ✓ Queue entry with correct fields (session_id, pane_id, reason, message)"
echo "  ✓ Unstuck detection on activity"
echo "  ✓ Dequeue after unstuck event"
echo ""
echo "Full detection lifecycle validated: quiet → stuck → activity → unstuck"
