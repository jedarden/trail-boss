#!/bin/bash
# Trail Boss hook emitter
# Forwards Claude Code hook payloads to the collector daemon, injecting $TMUX_PANE.
# All hooks route through this single script; the daemon normalizes events.
#
# Includes bounded retry/spool for daemon restart windows (see ADR-1 follow-on)

set -e

COLLECTOR_URL="${TRAILBOSS_COLLECTOR_URL:-http://localhost:4000/event}"
PANE_ID="${TMUX_PANE:-}"
SPOOL_FILE="${HOME}/.trailboss-spool.jsonl"
MAX_SPOOL_LINES=100

if [ -z "$PANE_ID" ]; then
  # Not running inside tmux — silently skip (headless/SDK sessions)
  exit 0
fi

# Read the payload from stdin
PAYLOAD=$(cat)

# Try POST with exponential backoff retry (3 attempts: 0ms, 100ms, 300ms)
POST_SUCCESS=false
for attempt in 1 2 3; do
  if curl -s -X POST "$COLLECTOR_URL" \
    --data-binary "$PAYLOAD" \
    -H "X-Tmux-Pane: $PANE_ID" \
    -H "Content-Type: application/json" \
    --connect-timeout 1 \
    --max-time 2 \
    -o /dev/null \
    -w "%{http_code}" \
    2>/dev/null | grep -q "200"; then
    POST_SUCCESS=true
    break
  fi

  # Exponential backoff: 0ms, 100ms, 300ms
  if [ "$attempt" -lt 3 ]; then
    sleep 0.$((attempt * 100))
  fi
done

# If all retries failed, spool the payload for daemon replay on startup
if [ "$POST_SUCCESS" = false ]; then
  # Create spool directory if needed
  SPOOL_DIR=$(dirname "$SPOOL_FILE")
  mkdir -p "$SPOOL_DIR"

  # Append to spool with pane_id and timestamp
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $PANE_ID $PAYLOAD" >> "$SPOOL_FILE"

  # Keep spool bounded: drop oldest if exceeds max lines
  if [ -f "$SPOOL_FILE" ]; then
    CURRENT_LINES=$(wc -l < "$SPOOL_FILE")
    if [ "$CURRENT_LINES" -gt "$MAX_SPOOL_LINES" ]; then
      # Drop oldest lines (keep last MAX_SPOOL_LINES)
      tail -n "$MAX_SPOOL_LINES" "$SPOOL_FILE" > "${SPOOL_FILE}.tmp"
      mv "${SPOOL_FILE}.tmp" "$SPOOL_FILE"
    fi
  fi
fi

# Hooks must exit 0 even if POST fails (fire-and-forget; collector may be down)
exit 0
