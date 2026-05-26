#!/bin/bash
# Trail Boss hook emitter
# Forwards Claude Code hook payloads to the collector daemon, injecting $TMUX_PANE.
# All hooks route through this single script; the daemon normalizes events.

set -e

COLLECTOR_URL="${TRAILBOSS_COLLECTOR_URL:-http://localhost:4000/event}"
PANE_ID="${TMUX_PANE:-}"

if [ -z "$PANE_ID" ]; then
  echo "trailboss-emit: error: TMUX_PANE not set" >&2
  exit 1
fi

# Forward stdin (the hook payload) to the collector, injecting the pane id via header
curl -s -X POST "$COLLECTOR_URL" \
  --data-binary @- \
  -H "X-Tmux-Pane: $PANE_ID" \
  -H "Content-Type: application/json" || true

# Hooks must exit 0 even if POST fails (fire-and-forget; collector may be down)
exit 0
