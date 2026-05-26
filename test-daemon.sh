#!/bin/bash
# Test the Trail Boss daemon with synthetic events

set -e

DAEMON_PID=""
TRANSCRIPT_TEST_DIR="/tmp/trailboss-test-$$"

cleanup() {
  echo "[test] cleaning up..."
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$TRANSCRIPT_TEST_DIR"
  rm -f ~/.local/share/trailboss/trailboss.db
}

trap cleanup EXIT

echo "[test] creating test transcripts..."
mkdir -p "$TRANSCRIPT_TEST_DIR"

# Start daemon in background
echo "[test] starting daemon..."
bun run /home/coding/trail-boss/daemon/index.ts &
DAEMON_PID=$!
sleep 2

# Verify /status
echo "[test] checking /status..."
STATUS=$(curl -s http://127.0.0.1:4000/status)
echo "$STATUS" | jq .
STUCK_COUNT=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK_COUNT" != "0" ]; then
  echo "[test] FAIL: expected stuckCount=0, got $STUCK_COUNT"
  exit 1
fi

# Test SessionStart event
echo "[test] sending SessionStart event..."
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %123" \
  -d '{
    "session_id": "test-session-1",
    "transcript_path": "/tmp/transcript.jsonl",
    "cwd": "/home/coding/test-project",
    "hook_event_name": "SessionStart"
  }' | jq .

# Test Stop event (should enqueue)
echo "[test] sending Stop event..."
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %123" \
  -d '{
    "session_id": "test-session-1",
    "transcript_path": "/tmp/transcript.jsonl",
    "cwd": "/home/coding/test-project",
    "hook_event_name": "Stop",
    "last_assistant_message": "I need permission to edit a file"
  }' | jq .

# Verify stuck count increased
sleep 1
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK_COUNT=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK_COUNT" != "1" ]; then
  echo "[test] FAIL: expected stuckCount=1 after Stop, got $STUCK_COUNT"
  exit 1
fi
echo "[test] OK: stuck count is 1"

# Test /next returns the pane
echo "[test] checking /next..."
NEXT=$(curl -s http://127.0.0.1:4000/next)
echo "$NEXT" | jq .
PANE_ID=$(echo "$NEXT" | jq -r '.paneId')
if [ "$PANE_ID" != "%123" ]; then
  echo "[test] FAIL: expected paneId=%123, got $PANE_ID"
  exit 1
fi
echo "[test] OK: /next returned correct pane"

# Test /skip
echo "[test] testing /skip..."
SKIP=$(curl -s -X POST http://127.0.0.1:4000/skip)
echo "$SKIP" | jq .
# After skip, queue should be empty (only one item)
PANE_ID=$(echo "$SKIP" | jq -r '.paneId')
if [ "$PANE_ID" != "null" ]; then
  echo "[test] FAIL: expected null paneId after skipping only item, got $PANE_ID"
  exit 1
fi
echo "[test] OK: skip moved item to tail, queue now appears empty"

# Test UserPromptSubmit dequeues
echo "[test] adding another session..."
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %456" \
  -d '{
    "session_id": "test-session-2",
    "transcript_path": "/tmp/transcript2.jsonl",
    "cwd": "/home/coding/test-project",
    "hook_event_name": "Stop",
    "last_assistant_message": "Another stuck session"
  }' > /dev/null

sleep 1
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK_COUNT=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK_COUNT" != "1" ]; then
  echo "[test] FAIL: expected stuckCount=1, got $STUCK_COUNT"
  exit 1
fi

# UserPromptSubmit should dequeue
echo "[test] sending UserPromptSubmit..."
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %456" \
  -d '{
    "session_id": "test-session-2",
    "transcript_path": "/tmp/transcript2.jsonl",
    "cwd": "/home/coding/test-project",
    "hook_event_name": "UserPromptSubmit"
  }' > /dev/null

sleep 1
STATUS=$(curl -s http://127.0.0.1:4000/status)
STUCK_COUNT=$(echo "$STATUS" | jq -r '.stuckCount')
if [ "$STUCK_COUNT" != "0" ]; then
  echo "[test] FAIL: expected stuckCount=0 after UserPromptSubmit, got $STUCK_COUNT"
  exit 1
fi
echo "[test] OK: UserPromptSubmit dequeued the session"

# Test PermissionRequest
echo "[test] testing PermissionRequest..."
curl -s -X POST http://127.0.0.1:4000/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %789" \
  -d '{
    "session_id": "test-session-3",
    "transcript_path": "/tmp/transcript3.jsonl",
    "cwd": "/home/coding/test-project",
    "hook_event_name": "PermissionRequest",
    "tool_name": "Edit",
    "tool_input": {
      "file_path": "/home/coding/test.txt",
      "old_string": "old",
      "new_string": "new"
    }
  }' > /dev/null

sleep 1
NEXT=$(curl -s http://127.0.0.1:4000/next)
PANE_ID=$(echo "$NEXT" | jq -r '.paneId')
if [ "$PANE_ID" != "%789" ]; then
  echo "[test] FAIL: expected paneId=%789 after PermissionRequest, got $PANE_ID"
  exit 1
fi
echo "[test] OK: PermissionRequest enqueued correctly"

# Test /queue listing (includes items on cooldown)
echo "[test] testing /queue..."
QUEUE=$(curl -s http://127.0.0.1:4000/queue)
echo "$QUEUE" | jq .
COUNT=$(echo "$QUEUE" | jq -r '.count')
# Should have 2 items: test-session-1 (skipped, on cooldown) and test-session-3 (permission)
if [ "$COUNT" != "2" ]; then
  echo "[test] FAIL: expected count=2, got $COUNT"
  exit 1
fi
# But /next should only return test-session-3 (test-session-1 is on cooldown)
NEXT=$(curl -s http://127.0.0.1:4000/next)
NEXT_SESSION=$(echo "$NEXT" | jq -r '.sessionId')
if [ "$NEXT_SESSION" != "test-session-3" ]; then
  echo "[test] FAIL: expected /next to return test-session-3, got $NEXT_SESSION"
  exit 1
fi
echo "[test] OK: /queue returned 2 items, /next respects cooldown"

echo ""
echo "[test] All tests passed!"
