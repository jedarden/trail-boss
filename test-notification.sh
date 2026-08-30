#!/usr/bin/env bash
# Test the Trail Boss notification system
# Tests that notifications are sent when queue depth crosses threshold

set -e

NOTIFY_TEST_DIR="/tmp/trailboss-notify-test-$$"
MOCK_PROXY_PORT=8081
MOCK_PROXY_PID=""

cleanup() {
  echo "[test] cleaning up..."
  [ -n "$MOCK_PROXY_PID" ] && kill "$MOCK_PROXY_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$NOTIFY_TEST_DIR"
}

trap cleanup EXIT

echo "[test] creating test environment..."
mkdir -p "$NOTIFY_TEST_DIR"

# Create a mock telegram-claude-bridge proxy server
echo "[test] starting mock telegram proxy on port $MOCK_PROXY_PORT..."
cat > "$NOTIFY_TEST_DIR/mock-proxy.ts" <<'EOF'
import * as http from "http";

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/send") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body);
        console.log(JSON.stringify({
          type: "notification_received",
          chat_id: payload.chat_id,
          text: payload.text,
          thread_id: payload.thread_id || null
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, message_id: 12345 }));
      } catch (err) {
        console.error(JSON.stringify({ type: "error", error: String(err) }));
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
  } else {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }
});

server.listen(8081, "127.0.0.1", () => {
  console.log(JSON.stringify({ type: "proxy_started", port: 8081 }));
});
EOF

# Start the mock proxy
cd "$NOTIFY_TEST_DIR"
/home/coding/.bun/bin/bun run mock-proxy.ts > proxy.log 2>&1 &
MOCK_PROXY_PID=$!
sleep 2

# Verify proxy is running
if ! kill -0 "$MOCK_PROXY_PID" 2>/dev/null; then
  echo "[test] FAIL: mock proxy failed to start"
  cat "$NOTIFY_TEST_DIR/proxy.log"
  exit 1
fi

echo "[test] mock proxy started (PID: $MOCK_PROXY_PID)"

# Start daemon with test environment variables
echo "[test] starting daemon with notification config..."
export TRAILBOSS_DATA_DIR="$NOTIFY_TEST_DIR/trailboss-data"
export TRAILBOSS_PORT="4001"  # Use different port to avoid conflict
export TELEGRAM_PROXY_URL="http://127.0.0.1:$MOCK_PROXY_PORT"
export TELEGRAM_CHAT_ID="test-chat-123"
export TELEGRAM_THREAD_ID="test-thread-456"
export NOTIFY_THRESHOLD="1"
export NOTIFY_COOLDOWN_MS="60000"  # 1 minute for testing
export NOTIFY_CHECK_INTERVAL_MS="5000"  # 5 seconds for testing

cd /home/coding/trail-boss/daemon
/home/coding/.bun/bin/bun run index.ts > "$NOTIFY_TEST_DIR/daemon.log" 2>&1 &
DAEMON_PID=$!
sleep 3

# Verify daemon started
if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
  echo "[test] FAIL: daemon failed to start"
  cat "$NOTIFY_TEST_DIR/daemon.log"
  exit 1
fi

echo "[test] daemon started (PID: $DAEMON_PID)"

# Check that notification checker started
if ! grep -q "starting checker" "$NOTIFY_TEST_DIR/daemon.log"; then
  echo "[test] FAIL: notification checker did not start"
  cat "$NOTIFY_TEST_DIR/daemon.log"
  exit 1
fi

echo "[test] OK: notification checker started"

# Wait for initial check (should have no items)
sleep 6
echo "[test] initial check completed"

# Send a stuck event to trigger notification
echo "[test] sending stuck event to trigger notification..."
curl -s -X POST http://127.0.0.1:4001/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %999" \
  -d '{
    "session_id": "notify-test-session",
    "transcript_path": "/tmp/test-notify.jsonl",
    "cwd": "/home/coding/test",
    "hook_event_name": "Stop",
    "last_assistant_message": "This is a test notification"
  }' > /dev/null

# Wait for notification check cycle
sleep 6

# Check if notification was sent
echo "[test] checking if notification was sent..."
if grep -q "notification_received" "$NOTIFY_TEST_DIR/proxy.log"; then
  NOTIFICATION=$(grep "notification_received" "$NOTIFY_TEST_DIR/proxy.log" | head -1)
  echo "[test] OK: notification received by proxy:"
  echo "$NOTIFICATION" | jq .

  # Verify notification content
  CHAT_ID=$(echo "$NOTIFICATION" | jq -r '.chat_id')
  if [ "$CHAT_ID" != "test-chat-123" ]; then
    echo "[test] FAIL: expected chat_id=test-chat-123, got $CHAT_ID"
    exit 1
  fi

  THREAD_ID=$(echo "$NOTIFICATION" | jq -r '.thread_id')
  if [ "$THREAD_ID" != "test-thread-456" ]; then
    echo "[test] FAIL: expected thread_id=test-thread-456, got $THREAD_ID"
    exit 1
  fi

  TEXT=$(echo "$NOTIFICATION" | jq -r '.text')
  if ! echo "$TEXT" | grep -q "Trail Boss Alert"; then
    echo "[test] FAIL: notification text missing 'Trail Boss Alert'"
    exit 1
  fi

  if ! echo "$TEXT" | grep -q "Queue depth:"; then
    echo "[test] FAIL: notification text missing queue depth"
    exit 1
  fi

  echo "[test] OK: notification content is correct"
else
  echo "[test] FAIL: notification was not sent"
  echo "[test] proxy log:"
  cat "$NOTIFY_TEST_DIR/proxy.log"
  echo "[test] daemon log:"
  cat "$NOTIFY_TEST_DIR/daemon.log"
  exit 1
fi

# Test cooldown: send another event and verify no duplicate notification
echo "[test] testing cooldown (should not send duplicate notification)..."
curl -s -X POST http://127.0.0.1:4001/event \
  -H "Content-Type: application/json" \
  -H "X-Tmux-Pane: %998" \
  -d '{
    "session_id": "notify-test-session-2",
    "transcript_path": "/tmp/test-notify2.jsonl",
    "cwd": "/home/coding/test",
    "hook_event_name": "Stop",
    "last_assistant_message": "Another test"
  }' > /dev/null

# Count notifications before
NOTIFICATIONS_BEFORE=$(grep -c "notification_received" "$NOTIFY_TEST_DIR/proxy.log" || echo "0")

# Wait for check cycle
sleep 6

# Count notifications after (should be same due to cooldown)
NOTIFICATIONS_AFTER=$(grep -c "notification_received" "$NOTIFY_TEST_DIR/proxy.log" || echo "0")

if [ "$NOTIFICATIONS_AFTER" -gt "$NOTIFICATIONS_BEFORE" ]; then
  echo "[test] FAIL: notification sent during cooldown period (should have been suppressed)"
  echo "[test] notifications before: $NOTIFICATIONS_BEFORE, after: $NOTIFICATIONS_AFTER"
  exit 1
fi

echo "[test] OK: cooldown prevented duplicate notification"

# Verify daemon logged the cooldown
if grep -q "in cooldown period" "$NOTIFY_TEST_DIR/daemon.log"; then
  echo "[test] OK: daemon logged cooldown correctly"
else
  echo "[test] WARNING: daemon did not log cooldown (might be timing issue)"
fi

echo ""
echo "[test] All notification tests passed!"
