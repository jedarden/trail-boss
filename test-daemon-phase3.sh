#!/bin/bash
# Phase 3 exit criteria tests: self-healing, reconcile, persistence

set -e

DAEMON_PID=""
TRANSCRIPT_TEST_DIR="/tmp/trailboss-test-$$"
DB_DIR="$HOME/.local/share/trailboss"

cleanup() {
  echo "[test] cleaning up..."
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$TRANSCRIPT_TEST_DIR"
  rm -f "$DB_DIR/trailboss.db"
}

# Ensure clean state before tests
rm -f "$DB_DIR/trailboss.db"
rm -rf "$TRANSCRIPT_TEST_DIR"

trap cleanup EXIT

echo "[test] Phase 3 exit criteria verification"
echo ""

mkdir -p "$TRANSCRIPT_TEST_DIR"

# === Test 1: Self-healing registry (second event with new pane) ===
echo "[test] 1. Self-healing registry: session moves to new pane"

# Start daemon
bun run /home/coding/trail-boss/daemon/index.ts &
DAEMON_PID=$!
sleep 2

# Register session on pane %111
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %111" \
  -d '{
    "session_id": "heal-test",
    "transcript_path": "/tmp/heal-test.jsonl",
    "cwd": "/home/coding/heal-test",
    "hook_event_name": "SessionStart"
  }' > /dev/null

# Enqueue as stuck
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %111" \
  -d '{
    "session_id": "heal-test",
    "transcript_path": "/tmp/heal-test.jsonl",
    "cwd": "/home/coding/heal-test",
    "hook_event_name": "Stop",
    "last_assistant_message": "Stuck on pane %111"
  }' > /dev/null

sleep 1
NEXT=$(curl -s http://127.0.0.1:4000/next)
PANE=$(echo "$NEXT" | jq -r '.paneId')
if [ "$PANE" != "%111" ]; then
  echo "[test] FAIL: expected %111, got $PANE"
  exit 1
fi

# Now same session emits from a different pane (pane reuse scenario)
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %222" \
  -d '{
    "session_id": "heal-test",
    "transcript_path": "/tmp/heal-test.jsonl",
    "cwd": "/home/coding/heal-test",
    "hook_event_name": "Stop",
    "last_assistant_message": "Stuck on pane %222 now"
  }' > /dev/null

sleep 1
NEXT=$(curl -s http://127.0.0.1:4000/next)
PANE=$(echo "$NEXT" | jq -r '.paneId')
if [ "$PANE" != "%222" ]; then
  echo "[test] FAIL: registry didn't self-heal: expected %222, got $PANE"
  exit 1
fi

# Clean up: dequeue the test session
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %222" \
  -d '{
    "session_id": "heal-test",
    "transcript_path": "/tmp/heal-test.jsonl",
    "cwd": "/home/coding/heal-test",
    "hook_event_name": "UserPromptSubmit"
  }' > /dev/null
sleep 1

echo "[test] PASS: registry self-healed to new pane"
echo ""

# === Test 2: Reconcile loop dequeues when transcript advances ===
echo "[test] 2. Reconcile loop: dequeue when transcript advances"

TRANSCRIPT="$TRANSCRIPT_TEST_DIR/reconcile-test.jsonl"

# Create a stuck session with a transcript
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %333" \
  -d "{
    \"session_id\": \"reconcile-test\",
    \"transcript_path\": \"$TRANSCRIPT\",
    \"cwd\": \"/home/coding/reconcile-test\",
    \"hook_event_name\": \"Stop\",
    \"last_assistant_message\": \"Waiting for reconcile\"
  }" > /dev/null

sleep 1
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK" != "1" ]; then
  echo "[test] FAIL: expected 1 stuck, got $STUCK"
  exit 1
fi

# Append a user message to the transcript (simulating "answered directly in pane")
STUCK_TIME=$(date +%s)000
cat >> "$TRANSCRIPT" <<EOF
{"type": "user_message", "role": "user", "content": "go ahead", "timestamp": $(($(date +%s)000))}
EOF

# Wait for reconcile loop (runs every 5s)
echo "[test] waiting for reconcile loop..."
sleep 7

STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK" != "0" ]; then
  echo "[test] FAIL: reconcile didn't dequeue: expected 0 stuck, got $STUCK"
  exit 1
fi
echo "[test] PASS: reconcile dequeued advanced session"
echo ""

# === Test 3: State persistence across daemon restart ===
echo "[test] 3. State persistence: survives daemon restart"

# Add a stuck session
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %444" \
  -d '{
    "session_id": "persist-test",
    "transcript_path": "/tmp/persist-test.jsonl",
    "cwd": "/home/coding/persist-test",
    "hook_event_name": "Stop",
    "last_assistant_message": "I should survive restart"
  }' > /dev/null

sleep 1
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK" != "1" ]; then
  echo "[test] FAIL: expected 1 stuck before restart, got $STUCK"
  exit 1
fi

# Kill and restart daemon
echo "[test] restarting daemon..."
kill "$DAEMON_PID"
sleep 1

bun run /home/coding/trail-boss/daemon/index.ts &
DAEMON_PID=$!
sleep 2

# Check state survived
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK" != "1" ]; then
  echo "[test] FAIL: state lost after restart: expected 1 stuck, got $STUCK"
  exit 1
fi

# Verify /next still works
NEXT=$(curl -s http://127.0.0.1:4000/next)
PANE=$(echo "$NEXT" | jq -r '.paneId')
if [ "$PANE" != "%444" ]; then
  echo "[test] FAIL: /next broken after restart: expected %444, got $PANE"
  exit 1
fi
echo "[test] PASS: state persisted across restart"
echo ""

echo ""
echo "=== All Phase 3 exit criteria verified ==="
