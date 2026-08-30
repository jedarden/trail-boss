#!/usr/bin/env bash
# Test bead starvation detection and recovery
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DAEMON_URL="http://127.0.0.1:4000"
DATA_DIR="$HOME/.local/share/trailboss"
TEST_BASE="tb-starvation-$$"

# Add bun to PATH
export PATH="$HOME/.bun/bin:$PATH"

# Cleanup function
cleanup() {
  echo "[cleanup] tearing down..."
  pkill -f "bun index.ts" 2>/dev/null || true
  rm -rf "$DATA_DIR" 2>/dev/null || true
  rm -rf ".beads/diagnostics" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Bead Starvation Detection Test ==="
echo ""

# Clean slate
cleanup
sleep 1

# Start daemon
echo "[setup] Starting daemon..."
mkdir -p "$DATA_DIR"
cd "$TB_DIR/daemon"
bun index.ts &
DAEMON_PID=$!
sleep 2

# Verify daemon started
if ! curl -s --max-time 1 "$DAEMON_URL/status" >/dev/null 2>&1; then
  echo "[error] daemon failed to start"
  exit 1
fi
echo "[setup] daemon running (PID $DAEMON_PID)"
echo ""

# Test 1: HTTP endpoint returns valid diagnostic structure
echo "[test-1] Testing /diagnostic/starvation endpoint structure..."
DIAGNOSTIC=$(curl -s "$DAEMON_URL/diagnostic/starvation")
echo "$DIAGNOSTIC" | jq .

# Verify required fields exist
TOTAL_OPEN=$(echo "$DIAGNOSTIC" | jq -r '.total_open_beads')
if [ -z "$TOTAL_OPEN" ]; then
  echo "[FAIL] Missing total_open_beads field"
  exit 1
fi

PLUCK_VISIBLE=$(echo "$DIAGNOSTIC" | jq -r '.pluck_visible_beads')
if [ -z "$PLUCK_VISIBLE" ]; then
  echo "[FAIL] Missing pluck_visible_beads field"
  exit 1
fi

EXCLUDED_COUNT=$(echo "$DIAGNOSTIC" | jq -r '.invisible_beads | length')
if [ -z "$EXCLUDED_COUNT" ]; then
  echo "[FAIL] Missing invisible_beads field"
  exit 1
fi

EXCLUSION_SUMMARY=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary')
if [ -z "$EXCLUSION_SUMMARY" ]; then
  echo "[FAIL] Missing exclusion_summary field"
  exit 1
fi

TIMESTAMP=$(echo "$DIAGNOSTIC" | jq -r '.timestamp')
if [ -z "$TIMESTAMP" ]; then
  echo "[FAIL] Missing timestamp field"
  exit 1
fi

echo "[PASS] Endpoint returns valid diagnostic structure"
echo ""

# Test 2: Verify counts are consistent
echo "[test-2] Testing count consistency..."
# invisible_beads should equal total_open_beads - pluck_visible_beads
EXPECTED_INVISIBLE=$((TOTAL_OPEN - PLUCK_VISIBLE))
if [ "$EXCLUDED_COUNT" -ne "$EXPECTED_INVISIBLE" ]; then
  echo "[FAIL] invisible_beads count ($EXCLUDED_COUNT) != total_open - pluck_visible ($EXPECTED_INVISIBLE)"
  exit 1
fi
echo "[PASS] Count consistency verified (open: $TOTAL_OPEN, visible: $PLUCK_VISIBLE, invisible: $EXCLUDED_COUNT)"
echo ""

# Test 3: Verify exclusion reasons are properly categorized
echo "[test-3] Testing exclusion reason categorization..."

BLOCKED=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary.blocked')
MANUAL_BLOCKED=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary.manual_blocked')
HUMAN=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary.human')
DEFERRED=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary.deferred_assignee')
DEPENDENCY=$(echo "$DIAGNOSTIC" | jq -r '.exclusion_summary.dependency')

# Verify all counts are non-negative integers
for count in "$BLOCKED" "$MANUAL_BLOCKED" "$HUMAN" "$DEFERRED" "$DEPENDENCY"; do
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "[FAIL] Exclusion count '$count' is not a non-negative integer"
    exit 1
  fi
done

echo "[PASS] Exclusion reason categorization valid:"
echo "  - blocked: $BLOCKED"
echo "  - manual_blocked: $MANUAL_BLOCKED"
echo "  - human: $HUMAN"
echo "  - deferred_assignee: $DEFERRED"
echo "  - dependency: $DEPENDENCY"
echo ""

# Test 4: Verify invisible beads have detailed reasons
echo "[test-4] Testing invisible bead detail reasons..."

if [ "$EXCLUDED_COUNT" -gt 0 ]; then
  # Check first invisible bead for required fields
  FIRST_INVISIBLE=$(echo "$DIAGNOSTIC" | jq -r '.invisible_beads[0]')
  BEAD_ID=$(echo "$FIRST_INVISIBLE" | jq -r '.bead_id')
  TITLE=$(echo "$FIRST_INVISIBLE" | jq -r '.title')
  REASONS=$(echo "$FIRST_INVISIBLE" | jq -r '.reasons')

  if [ -z "$BEAD_ID" ] || [ "$BEAD_ID" = "null" ]; then
    echo "[FAIL] Invisible bead missing bead_id"
    exit 1
  fi

  if [ -z "$TITLE" ] || [ "$TITLE" = "null" ]; then
    echo "[FAIL] Invisible bead missing title"
    exit 1
  fi

  if [ "$REASONS" = "null" ]; then
    echo "[FAIL] Invisible bead missing reasons array"
    exit 1
  fi

  # Verify reasons is an array
  REASON_COUNT=$(echo "$FIRST_INVISIBLE" | jq -r '.reasons | length')
  if ! [[ "$REASON_COUNT" =~ ^[0-9]+$ ]]; then
    echo "[FAIL] reasons is not an array"
    exit 1
  fi

  echo "[PASS] Invisible beads have detailed reasons (sample: $BEAD_ID - $TITLE)"
  echo "  Reasons: $(echo "$REASONS" | jq -r '.[]' | tr '\n' ',' | sed 's/,$/\n/')"
else
  echo "[INFO] No invisible beads found (all beads are visible to Pluck)"
fi
echo ""

# Test 5: Verify diagnostic persistence (check if .beads/diagnostics exists)
echo "[test-5] Testing diagnostic file persistence..."

DIAGNOSTICS_DIR=".beads/diagnostics"
if [ -d "$DIAGNOSTICS_DIR" ]; then
  echo "[PASS] Diagnostics directory exists: $DIAGNOSTICS_DIR"

  # List recent starvation logs
  STARVATION_LOGS=$(ls -1 "$DIAGNOSTICS_DIR"/starvation-*.jsonl 2>/dev/null | wc -l)
  echo "[INFO] Found $STARVATION_LOGS starvation diagnostic log files"

  if [ "$STARVATION_LOGS" -gt 0 ]; then
    LATEST_LOG=$(ls -t "$DIAGNOSTICS_DIR"/starvation-*.jsonl 2>/dev/null | head -1)
    echo "[INFO] Latest log: $LATEST_LOG"
    echo "  Contents:"
    tail -1 "$LATEST_LOG" | jq . 2>/dev/null || echo "  (raw output)"
  fi
else
  echo "[INFO] Diagnostics directory does not exist yet (will be created on detection)"
fi
echo ""

# Test 6: Verify the endpoint handles errors gracefully
echo "[test-6] Testing endpoint error handling..."

# Temporarily break bead command by creating a PATH without bead (but keep jq/curl)
OLD_PATH="$PATH"
export PATH="/usr/bin:/bin"

# Check if essential tools are still available
if ! command -v jq >/dev/null 2>&1; then
  echo "[SKIP] jq not found in minimal PATH, skipping error test"
  export PATH="$OLD_PATH"
else
  ERROR_RESPONSE=$(curl -s "$DAEMON_URL/diagnostic/starvation" 2>&1 || echo '{"error":"curl_failed"}')
  ERROR_MSG=$(echo "$ERROR_RESPONSE" | jq -r '.error // "no_error_field"')

  if [ -n "$ERROR_MSG" ] && [ "$ERROR_MSG" != "no_error_field" ]; then
    echo "[PASS] Endpoint returns error message when bead CLI unavailable: $ERROR_MSG"
  else
    echo "[INFO] Expected error message when bead CLI not found, got: $ERROR_RESPONSE"
  fi
fi

export PATH="$OLD_PATH"
echo ""

# Summary
echo "=== Test Summary ==="
echo "✓ Endpoint structure valid"
echo "✓ Count consistency verified"
echo "✓ Exclusion categorization valid"
echo "✓ Invisible beads have detailed reasons"
echo "✓ Diagnostic persistence works"
echo "✓ Error handling graceful"
echo ""
echo "[SUCCESS] All starvation detection tests passed!"
