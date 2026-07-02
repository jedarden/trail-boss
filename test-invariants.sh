#!/bin/bash
# Invariant tests for Trail Boss daemon
# Tests the trust boundary and input guarantees specified in docs/plan/plan.md

set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss"
DAEMON_PID=""

# Cleanup function
cleanup() {
  echo "[cleanup] stopping daemon..."
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Invariant Tests ==="
echo "Testing trust boundary and input guarantees"
echo ""

# Clean slate
cleanup
mkdir -p "$DATA_DIR"

# ========================================================================
# Invariant 1: Daemon binds loopback only (127.0.0.1)
# ========================================================================
echo "=== Invariant 1: Loopback-only binding ==="

# Start daemon and capture its log output
cd "$TB_DIR/daemon"
bun index.ts > /tmp/trailboss-daemon-log-$$ 2>&1 &
DAEMON_PID=$!
sleep 2

# Check the log for the binding address
if grep -q "listening on http://127.0.0.1:4000" /tmp/trailboss-daemon-log-$$; then
  echo "[ok] Daemon bound to 127.0.0.1:4000 (loopback only)"
else
  echo "[fail] Daemon did not log loopback binding"
  cat /tmp/trailboss-daemon-log-$$
  exit 1
fi

# Verify daemon is reachable on loopback
if curl -s --max-time 1 "$DAEMON_URL/status" >/dev/null 2>&1; then
  echo "[ok] Daemon is reachable on loopback (127.0.0.1)"
else
  echo "[fail] Daemon not reachable on loopback"
  exit 1
fi

# Verify daemon is NOT reachable on a non-loopback interface
# Get the first non-loopback IP address (if any)
NON_LOOPBACK_IP=$(ip -4 addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '^127\.' | head -1 || echo "")

if [ -n "$NON_LOOPBACK_IP" ]; then
  # Try to connect on the non-loopback interface - should fail
  if curl -s --max-time 1 "http://$NON_LOOPBACK_IP:4000/status" >/dev/null 2>&1; then
    echo "[fail] Daemon is reachable on non-loopback interface $NON_LOOPBACK_IP"
    exit 1
  else
    echo "[ok] Daemon is NOT reachable on non-loopback interface $NON_LOOPBACK_IP"
  fi
else
  echo "[skip] No non-loopback interface available for testing"
fi

rm -f /tmp/trailboss-daemon-log-$$

# ========================================================================
# Invariant 2: No synthesized input (no tmux send-keys in daemon sources)
# ========================================================================
echo ""
echo "=== Invariant 2: No synthesized input ==="

# Check all daemon TypeScript sources for tmux send-keys invocations
DAEMON_SOURCES=$(find "$TB_DIR/daemon" -name "*.ts" -type f)
SEND_KEYS_COUNT=$(grep -r "send-keys" $DAEMON_SOURCES 2>/dev/null | wc -l)

if [ "$SEND_KEYS_COUNT" -eq 0 ]; then
  echo "[ok] No 'send-keys' found in daemon source files"
else
  echo "[fail] Found $SEND_KEYS_COUNT occurrences of 'send-keys' in daemon sources:"
  grep -r "send-keys" $DAEMON_SOURCES 2>/dev/null
  exit 1
fi

# Also check for the more explicit "tmux.*send-keys" pattern
TMUX_SEND_KEYS_COUNT=$(grep -rE "tmux.*send-keys|send-keys.*tmux" $DAEMON_SOURCES 2>/dev/null | wc -l)

if [ "$TMUX_SEND_KEYS_COUNT" -eq 0 ]; then
  echo "[ok] No 'tmux send-keys' patterns found in daemon source files"
else
  echo "[fail] Found $TMUX_SEND_KEYS_COUNT occurrences of tmux/send-keys patterns:"
  grep -rE "tmux.*send-keys|send-keys.*tmux" $DAEMON_SOURCES 2>/dev/null
  exit 1
fi

# ========================================================================
# Invariant 3: OPTIONS preflight is no longer honored (trust boundary)
# ========================================================================
echo ""
echo "=== Invariant 3: OPTIONS preflight rejected ==="

# Send an OPTIONS preflight request (what a browser would send for CORS)
OPTIONS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X OPTIONS "$DAEMON_URL/event" \
  -H "Origin: http://evil.example.com" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: X-Tmux-Pane")

if [ "$OPTIONS_STATUS" = "404" ]; then
  echo "[ok] OPTIONS preflight returns 404 (CORS not supported)"
elif [ "$OPTIONS_STATUS" = "204" ]; then
  echo "[fail] OPTIONS preflight returns 204 (CORS is still enabled - trust boundary violated)"
  exit 1
elif [ "$OPTIONS_STATUS" = "200" ]; then
  echo "[fail] OPTIONS preflight returns 200 (unusual response)"
  exit 1
else
  echo "[ok] OPTIONS preflight returns $OPTIONS_STATUS (not 204, CORS not supported)"
fi

# ========================================================================
# Summary
# ========================================================================
echo ""
echo "=== All Invariant Tests Passed ==="
echo ""
echo "✓ Invariant 1: Daemon binds loopback only"
echo "✓ Invariant 2: No synthesized input (no send-keys in daemon)"
echo "✓ Invariant 3: OPTIONS preflight rejected (CORS disabled)"
echo ""
echo "[ok] Trust boundary and input guarantees verified"
