#!/usr/bin/env bash
# Trail Boss marathon launcher.
# Runs claude headless in a loop: each iteration pipes instruction.md to
# `claude --print`, which does one unit of work, commits, pushes, and exits;
# the loop restarts it fresh. Model/proxy config comes from .marathon/env
# (untracked — copy env.example to env and fill in).
#
# Usage:
#   ./.marathon/launch-marathon.sh                 # session "trailboss-marathon"
#   ./.marathon/launch-marathon.sh my-session
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
INSTRUCTION_FILE="$SCRIPT_DIR/instruction.md"
CONFIG_DIR="$SCRIPT_DIR/glm47-config"
ENV_FILE="$SCRIPT_DIR/env"
LOG_DIR="$SCRIPT_DIR/logs"
SESSION_NAME="${1:-trailboss-marathon}"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — copy env.example to env and fill it in." >&2; exit 1; }
[ -f "$INSTRUCTION_FILE" ] || { echo "Missing $INSTRUCTION_FILE" >&2; exit 1; }

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a   # exports ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, model slots, etc.
mkdir -p "$LOG_DIR" "$CONFIG_DIR"

if tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
  echo "Session '$SESSION_NAME' already exists. Attach: tmux attach -t $SESSION_NAME"
  exit 0
fi

MODEL="${ANTHROPIC_MODEL:-glm-4.7}"
LOG="$LOG_DIR/session_$(date +%Y%m%d_%H%M%S).jsonl"

LOOP_CMD="cd '$REPO_DIR' && unset CLAUDECODE && set -a && source '$ENV_FILE' && set +a && export CLAUDE_CONFIG_DIR='$CONFIG_DIR' && while true; do
  echo \"[trailboss-marathon] iteration start \$(date -Iseconds)\"
  cat '$INSTRUCTION_FILE' | claude --model '$MODEL' --dangerously-skip-permissions --output-format stream-json --verbose --print 2>&1 | tee -a '$LOG'
  ec=\$?
  echo \"[trailboss-marathon] iteration done (exit \$ec) \$(date -Iseconds)\"
  if [ \$ec -ne 0 ]; then sleep 30; else sleep 5; fi
done"

tmux new-session -d -s "$SESSION_NAME" -c "$REPO_DIR"
tmux send-keys -t "$SESSION_NAME" "$LOOP_CMD" Enter

echo "Marathon running: $SESSION_NAME (model: $MODEL)"
echo "  Attach: tmux attach -t $SESSION_NAME   Stop: tmux kill-session -t $SESSION_NAME"
echo "  Logs:   $LOG"
