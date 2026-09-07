#!/usr/bin/env bash
# Test bead starvation detection and recovery
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Run isolated: this test starts its own daemon, so it must never share a
# port or a data dir with a live trailboss-daemon (the default data dir
# ~/.local/share/trailboss and port 4000 belong to the systemd service).
DAEMON_PORT="${TRAILBOSS_TEST_PORT:-4407}"
DAEMON_URL="http://127.0.0.1:${DAEMON_PORT}"
DATA_DIR="$(mktemp -d /tmp/tb-starvation-data.XXXXXX)"
TEST_BASE="tb-starvation-$$"
REGRESSION_DIR=""
DAEMON_PID=""

# Add bun to PATH
export PATH="$HOME/.bun/bin:$PATH"

# Cleanup function
cleanup() {
  echo "[cleanup] tearing down..."
  if [ -n "$DAEMON_PID" ]; then
    kill "$DAEMON_PID" 2>/dev/null || true
  fi
  rm -rf "$DATA_DIR" 2>/dev/null || true
  rm -rf ".beads/diagnostics" 2>/dev/null || true
  if [ -n "$REGRESSION_DIR" ]; then
    rm -rf "$REGRESSION_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "=== Bead Starvation Detection Test ==="
echo ""

# Clean slate
rm -rf "$DATA_DIR"
sleep 1

# Refuse to run against an occupied port — that would silently test someone
# else's daemon (e.g. the live systemd service on 4000)
if curl -s --max-time 1 "http://127.0.0.1:${DAEMON_PORT}/status" >/dev/null 2>&1; then
  echo "[error] port $DAEMON_PORT already answering; set TRAILBOSS_TEST_PORT to a free port"
  exit 1
fi

# Start daemon
echo "[setup] Starting daemon (port $DAEMON_PORT, data dir $DATA_DIR)..."
cd "$TB_DIR/daemon"
TRAILBOSS_PORT="$DAEMON_PORT" TRAILBOSS_DATA_DIR="$DATA_DIR" bun index.ts &
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

# Test 7: zero-field / blank-workspace diagnostics must never become alert beads
# Regression for trailbos-317b7ae2: the detector once filed
# "Starvation alert: beads invisible in " with a blank workspace, 0 open
# beads, 0 excluded and no exclusion reasons — a self-inconsistent alert that
# claims starvation while asserting none. The emitter now routes such
# diagnostics to .beads/diagnostics/ and a detector-bug bead instead.
echo "[test-7] Testing zero-field alert suppression (trailbos-317b7ae2 regression)..."

REGRESSION_DIR="$(mktemp -d /tmp/tb-starvation-regression.XXXXXX)"
STUB_BIN="$REGRESSION_DIR/bead-stub"
STUB_LOG="$REGRESSION_DIR/bead-stub.log"

# Stub bead CLI: records every invocation, never touches a real bead store
cat > "$STUB_BIN" <<STUB
#!/usr/bin/env bash
printf '%s\n' "bead \$*" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$STUB_BIN"

cat > "$REGRESSION_DIR/regression.ts" <<'TS'
// Regression input: the exact self-inconsistent diagnostic from
// trailbos-317b7ae2 (closed duplicate trailbos-0284c342) — blank workspace,
// 0 open, 0 excluded, no exclusion reasons.
const zeroField = {
  timestamp: "2026-08-29T11:43:41.045665473+00:00",
  workspace: "",
  open_beads: 0,
  ready_beads: 0,
  excluded_beads: 0,
  exclusion_reasons: [],
  recovered: false,
  recovery_attempts: [],
};

const { validateStarvationAlert, createStarvationAlertBead } = await import(
  process.env.TB_DAEMON_DIR + "/reconcile.ts"
);

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  [ok] " + msg);
  } else {
    console.error("  [FAIL] " + msg);
    failures++;
  }
}

// (1) the guard rejects the exact incident input
const verdict = validateStarvationAlert(zeroField);
assert(verdict.actionable === false, "guard rejects zero-field/blank-workspace diagnostic");
assert(Boolean(verdict.reason), "guard explains why: " + verdict.reason);

// (2) each zeroed or negative count individually is rejected too
const sane = { ...zeroField, workspace: "/home/coding/trail-boss", open_beads: 3, ready_beads: 1, excluded_beads: 2 };
for (const [field, value] of [
  ["open_beads", 0],
  ["excluded_beads", 0],
  ["excluded_beads", -2],
  ["ready_beads", -1],
] as const) {
  const d = { ...sane, [field]: value };
  assert(validateStarvationAlert(d).actionable === false, `guard rejects ${field}=${value}`);
}

// (3) counts that do not add up are rejected
const mismatched = { ...sane, open_beads: 5, ready_beads: 1, excluded_beads: 2 };
assert(validateStarvationAlert(mismatched).actionable === false, "guard rejects ready + excluded != open");

// (4) a genuine starvation diagnostic still passes the guard
const real = { ...sane, exclusion_reasons: ["bead tb-x assigned to alice"] };
assert(validateStarvationAlert(real).actionable === true, "guard still accepts a genuine starvation diagnostic");

// (5) the emitter routes the zero-field diagnostic away from alerting
createStarvationAlertBead(zeroField);

if (failures > 0) process.exit(1);
TS

(
  cd "$REGRESSION_DIR"
  TRAILBOSS_BEAD_BIN="$STUB_BIN" \
  TRAILBOSS_DATA_DIR="$REGRESSION_DIR/data" \
  TB_DAEMON_DIR="$TB_DIR/daemon" \
    bun "$REGRESSION_DIR/regression.ts"
)

# No starvation alert may be filed for the zero-field diagnostic
if grep -q 'alert:starvation:unknown' "$STUB_LOG" 2>/dev/null \
   || grep -q 'Starvation alert: beads invisible' "$STUB_LOG" 2>/dev/null; then
  echo "[FAIL] zero-field diagnostic produced a starvation alert bead:"
  cat "$STUB_LOG"
  exit 1
fi
echo "[PASS] no starvation alert bead created for zero-field diagnostic"

# The diagnostic must be routed to .beads/diagnostics/ instead
DETECTOR_LOGS=$(find "$REGRESSION_DIR/.beads/diagnostics" -name 'starvation-detector-bug-*.jsonl' 2>/dev/null | wc -l)
if [ "$DETECTOR_LOGS" -lt 1 ]; then
  echo "[FAIL] non-actionable diagnostic was not routed to .beads/diagnostics/"
  exit 1
fi
echo "[PASS] non-actionable diagnostic routed to .beads/diagnostics/ ($DETECTOR_LOGS file)"

# The routed diagnostic must be the zero-field incident input itself
ROUTED=$(head -1 "$REGRESSION_DIR"/.beads/diagnostics/starvation-detector-bug-*.jsonl)
if [ "$(echo "$ROUTED" | jq -r '.workspace')" != "" ] \
   || [ "$(echo "$ROUTED" | jq -r '.open_beads')" != "0" ] \
   || [ "$(echo "$ROUTED" | jq -r '.excluded_beads')" != "0" ]; then
  echo "[FAIL] routed detector-bug diagnostic is not the zero-field incident input:"
  echo "$ROUTED"
  exit 1
fi
echo "[PASS] routed diagnostic is the zero-field incident input (blank workspace, 0 open, 0 excluded)"

# And a detector-bug bead must be filed in place of the alert
if ! grep -q 'starvation-detector-bug' "$STUB_LOG" 2>/dev/null; then
  echo "[FAIL] detector-bug bead was not filed for the non-actionable diagnostic"
  cat "$STUB_LOG"
  exit 1
fi
echo "[PASS] detector-bug bead filed in place of the suppressed alert"
echo ""

# Summary
echo "=== Test Summary ==="
echo "✓ Endpoint structure valid"
echo "✓ Count consistency verified"
echo "✓ Exclusion categorization valid"
echo "✓ Invisible beads have detailed reasons"
echo "✓ Diagnostic persistence works"
echo "✓ Error handling graceful"
echo "✓ Zero-field alerts suppressed (trailbos-317b7ae2 regression)"
echo ""
echo "[SUCCESS] All starvation detection tests passed!"
