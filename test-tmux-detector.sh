#!/bin/bash
# Phase 7 Tmux Detector Acceptance Test
#
# Validates the full detection lifecycle: quiet → stuck → activity → unstuck
# Test scenario:
# 1. Create a throwaway tmux session with a test pane
# 2. Make the test pane go quiet (simulate a stuck session)
# 3. Verify the pane appears in the Trail Boss queue with appropriate reason
# 4. Type into the pane (simulate user activity)
# 5. Verify the pane dequeues (unstuck event processed)
#
# Test harness rules:
# - Uses isolated tmux socket (never touches user's main server)
# - Short QUIET_THRESHOLD_MS for fast testing (3s instead of 30s)
# - All test sessions are torn down on exit

set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss"

# Isolated tmux socket — never touches the user's main server
TMUX_TEST_SOCK="/tmp/tmux-trailboss-detector-$$"
TMUX="tmux -S $TMUX_TEST_SOCK"

# Fast thresholds for testing (override defaults)
export TRAILBOSS_POLL_INTERVAL_MS=500   # Check every 0.5s
export TRAILBOSS_QUIET_THRESHOLD_MS=3000 # 3s quiet = stuck
export TRAILBOSS_DAEMON_URL="$DAEMON_URL/event/normalized"
export TRAILBOSS_OPT_IN_PREFIX="@tb-test-"

# Cleanup function
cleanup() {
  echo "[cleanup] tearing down test environment..."

  # Stop detector
  pkill -f "tmux-detector.ts" 2>/dev/null || true

  # Stop daemon
  pkill -f "bun index.ts" 2>/dev/null || true

  # Kill test tmux server
  $TMUX kill-server 2>/dev/null || true

  # Clean up data dir
  rm -rf "$DATA_DIR" 2>/dev/null || true

  # Remove socket file
  rm -f "$TMUX_TEST_SOCK" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Tmux Detector Acceptance Test ==="
echo "Testing: quiet → stuck → activity → unstuck lifecycle"
echo ""

# Clean slate
cleanup
sleep 1

# Start daemon
echo "[setup] Starting daemon..."
mkdir -p "$DATA_DIR"
cd "$TB_DIR/daemon"
bun index.ts > /tmp/tb-daemon-log-$$ 2>&1 &
DAEMON_PID=$!
sleep 2

# Verify daemon started
if ! curl -s --max-time 1 "$DAEMON_URL/status" >/dev/null 2>&1; then
  echo "[error] daemon failed to start"
  cat /tmp/tb-daemon-log-$$
  exit 1
fi
echo "[setup] daemon running (PID $DAEMON_PID)"

# Start a fresh tmux server for testing
$TMUX start-server 2>/dev/null || true

# Helper: create a test pane with @tb- prefix
create_test_pane() {
  local name=$1
  local title=$2
  # Create session with a shell that will show a prompt and then wait
  # Use bash with a command that ends, leaving us at a prompt
  $TMUX new-session -d -s "$name" "bash -c 'echo ready; bash'"
  # Set the pane title (not window name) - this is what the detector checks
  $TMUX select-pane -t "$name" -T "$title"
  local pane_id=$($TMUX display -p -t "$name" '#{pane_id}')
  echo "$pane_id"
}

# Helper: get queue contents
get_queue() {
  curl -s --max-time 1 "$DAEMON_URL/queue" || echo '{"queue":[]}'
}

# Helper: check if session is in queue
session_in_queue() {
  local session_id=$1
  local queue=$(get_queue)
  echo "$queue" | grep -q "$session_id"
}

# Helper: count queue entries
queue_count() {
  local queue=$(get_queue)
  # Extract count from JSON response
  echo "$queue" | grep -o '"count":[0-9]*' | cut -d: -f2 || echo "0"
}

# ============================================================================
# Step 1: Create a test pane with @tb- prefix
# ============================================================================
echo ""
echo "[step 1] Creating test pane with @tb- prefix..."
TEST_PANE_ID=$(create_test_pane "test-session" "@tb-test-detector-acceptance")
echo "[step 1] Created test pane: $TEST_PANE_ID"

# ============================================================================
# Step 2: Start the tmux detector
# ============================================================================
echo ""
echo "[step 2] Starting tmux detector..."
cd "$TB_DIR/daemon"
TRAILBOSS_POLL_INTERVAL_MS=500 \
TRAILBOSS_QUIET_THRESHOLD_MS=3000 \
TRAILBOSS_DAEMON_URL="$DAEMON_URL/event/normalized" \
TRAILBOSS_OPT_IN_PREFIX="@tb-test-" \
bun tmux-detector.ts > /tmp/tb-detector-log-$$ 2>&1 &
DETECTOR_PID=$!
echo "[step 2] detector running (PID $DETECTOR_PID)"

# Give detector time to discover the pane
echo "[step 2] waiting for detector to discover pane..."
sleep 2

# Check detector discovered the pane
if ! grep -q "registered pane" /tmp/tb-detector-log-$$; then
  echo "[error] detector failed to discover pane"
  cat /tmp/tb-detector-log-$$
  exit 1
fi
echo "[step 2] detector discovered pane (logged registration)"

# Extract session_id from registration log
SESSION_ID=$(grep "registered pane" /tmp/tb-detector-log-$$ | tail -1 | sed 's/.*as \([^ ]*\).*/\1/')
if [ -z "$SESSION_ID" ]; then
  echo "[error] could not extract session_id from registration"
  cat /tmp/tb-detector-log-$$
  exit 1
fi
echo "[step 2] session_id: $SESSION_ID"

# ============================================================================
# Step 3: Wait for stuck detection (quiet threshold exceeded)
# ============================================================================
echo ""
echo "[step 3] Waiting for stuck detection (quiet threshold: 3s)..."

# Wait for quiet threshold + poll buffer
sleep 5

# Check detector logged stuck event
if ! grep -q "stuck:" /tmp/tb-detector-log-$$; then
  echo "[error] detector failed to detect stuck state"
  cat /tmp/tb-detector-log-$$
  exit 1
fi
echo "[step 3] detector logged stuck event"

# ============================================================================
# Step 4: Verify pane appears in Trail Boss queue
# ============================================================================
echo ""
echo "[step 4] Verifying pane appears in queue..."

QUEUE=$(get_queue)
QUEUE_COUNT=$(queue_count)
echo "[step 4] queue has $QUEUE_COUNT entries"

if [ "$QUEUE_COUNT" -lt 1 ]; then
  echo "[error] queue is empty, expected 1 entry"
  echo "[step 4] queue response: $QUEUE"
  exit 1
fi

# Verify the session is in the queue
if ! session_in_queue "$SESSION_ID"; then
  echo "[error] session $SESSION_ID not found in queue"
  echo "[step 4] queue response: $QUEUE"
  exit 1
fi
echo "[step 4] session $SESSION_ID found in queue ✓"

# Verify reason is "stopped" (tmux detector can't distinguish permission)
QUEUE_REASON=$(echo "$QUEUE" | grep -o '"reason":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$QUEUE_REASON" != "stopped" ]; then
  echo "[error] expected reason='stopped', got '$QUEUE_REASON'"
  exit 1
fi
echo "[step 4] reason is 'stopped' ✓"

# ============================================================================
# Step 5: Simulate user activity (type into pane)
# ============================================================================
echo ""
echo "[step 5] Simulating user activity (typing into pane)..."

# Send some input to the pane to change its output
# Run a loop that keeps outputting so the pane doesn't go quiet again
$TMUX send-keys -t "$TEST_PANE_ID" "while true; do echo 'activity'; sleep 0.5; done" Enter
sleep 1

# ============================================================================
# Step 6: Verify pane dequeues (unstuck event processed)
# ============================================================================
echo ""
echo "[step 6] Waiting for unstuck detection..."

# Wait for detector to notice output change and emit unstuck
sleep 3

# Check detector logged unstuck event
if ! grep -q "unstuck:" /tmp/tb-detector-log-$$; then
  echo "[error] detector failed to detect unstuck state"
  cat /tmp/tb-detector-log-$$
  exit 1
fi
echo "[step 6] detector logged unstuck event"

# Verify session removed from queue
QUEUE=$(get_queue)
QUEUE_COUNT=$(queue_count)
echo "[step 6] queue has $QUEUE_COUNT entries after activity"

if session_in_queue "$SESSION_ID"; then
  echo "[error] session still in queue after unstuck event"
  echo "[step 6] queue response: $QUEUE"
  exit 1
fi
echo "[step 6] session $SESSION_ID removed from queue ✓"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "=== Test Passed ==="
echo "✓ Tmux detector discovered opted-in pane"
echo "✓ Pane transitioned to stuck after quiet threshold"
echo "✓ Pane appeared in Trail Boss queue with reason='stopped'"
echo "✓ Pane transitioned to unstuck after activity"
echo "✓ Pane removed from queue after unstuck event"
echo ""
echo "Full detector log available at: /tmp/tb-detector-log-$$"
echo "Full daemon log available at: /tmp/tb-daemon-log-$$"
exit 0
