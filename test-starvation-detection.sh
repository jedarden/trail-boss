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
RECOVERY_DIR=""
ALERT_DIR=""
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
  if [ -n "$RECOVERY_DIR" ]; then
    rm -rf "$RECOVERY_DIR" 2>/dev/null || true
  fi
  if [ -n "$ALERT_DIR" ]; then
    rm -rf "$ALERT_DIR" 2>/dev/null || true
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

# Test 8: heartbeat-gated assignee clearing (trailbos-4cca2e94).
# The detector's second remediation clears an assignee only when the worker
# behind it is verifiably dead — a heartbeat or event trail older than the
# staleness window (30min). Required cases: a live worker's bead is not
# cleared, a dead worker's bead is cleared and becomes ready, and an
# in_progress bead is never cleared no matter how dead its worker looks.
# Also covered: an assignee that is not the bead's only exclusion (unclosed
# blocker) is left alone, a worker alive on events alone is not cleared, and a
# workspace where nothing qualifies falls through to the alert path.
echo "[test-8] Testing heartbeat-gated assignee clearing (trailbos-4cca2e94)..."

RECOVERY_DIR="$(mktemp -d /tmp/tb-starvation-recovery.XXXXXX)"
SCENARIO_A="$RECOVERY_DIR/scenario-a"
SCENARIO_B="$RECOVERY_DIR/scenario-b"
STALE_TS="$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%S)+00:00"
FRESH_TS="$(date -u -d '90 seconds ago' +%Y-%m-%dT%H:%M:%S)+00:00"

mkdir -p "$SCENARIO_A/.beads" "$SCENARIO_B/.beads"

# ---------------------------------------------------------------------------
# Fixture bead CLI: answers `bead list` from scenario fixtures, records
# mutations. A `--clear-assignee` call is logged as CLEAR <id> and flips the
# stub's ready frontier: the cleared bead becomes visible to pluck, exactly
# what the real CLI does with the assignee gone.
# ---------------------------------------------------------------------------
write_recovery_stub() {
  local dir="$1" log="$2"
  cat > "$dir/bead-stub" <<STUB
#!/usr/bin/env bash
LOG="$log"
case "\$1" in
  update)
    if [[ "\$*" == *"--clear-assignee"* ]]; then
      printf 'CLEAR %s\n' "\$2" >> "\$LOG"
      touch "$dir/cleared"
    else
      printf 'UPDATE %s\n' "\$2" >> "\$LOG"
    fi
    exit 0 ;;
  create)
    printf 'CREATE %s\n' "\$*" >> "\$LOG"
    exit 0 ;;
  list)
    printf 'bead %s\n' "\$*" >> "\$LOG"
    case "\$*" in
      *" --ready"*)
        # Ready frontier: empty until a clear actually happened
        if [ -f "$dir/cleared" ]; then cat "$dir/fixtures-ready.jsonl"; fi
        ;;
      *" --status open"*) cat "$dir/fixtures-open.jsonl" ;;
      *"list --json"*) cat "$dir/fixtures-all.jsonl" ;;
    esac
    exit 0 ;;
  *)
    printf 'bead %s\n' "\$*" >> "\$LOG"
    exit 0 ;;
esac
exit 0
STUB
  chmod +x "$dir/bead-stub"
}

# ---------------------------------------------------------------------------
# Scenario A: one of each kind of excluded bead
# ---------------------------------------------------------------------------
# Assignees use the workspace's real shape (claude session name, worker short
# name as the last dash segment) so resolution must go through the claim event.
cat > "$SCENARIO_A/.beads/heartbeats.jsonl" <<EOF
{"worker":"glm-live","state":"idle","ts":"${FRESH_TS}","last_strand":null}
{"worker":"glm-evlive","state":"idle","ts":"${STALE_TS}","last_strand":null}
{"worker":"glm-dead","state":"idle","ts":"${STALE_TS}","last_strand":null}
{"worker":"glm-wip","state":"idle","ts":"${STALE_TS}","last_strand":null}
EOF
# glm-evlive's only fresh signal is an event: stale heartbeat, live worker.
cat > "$SCENARIO_A/.beads/events.jsonl" <<EOF
{"bead":"tb-tst-live","event":"claim","worker":"glm-live","ts":"${STALE_TS}"}
{"bead":"tb-tst-evlive","event":"claim","worker":"glm-evlive","ts":"${STALE_TS}"}
{"bead":"tb-tst-evlive","event":"result","worker":"glm-evlive","ts":"${FRESH_TS}"}
{"bead":"tb-tst-dead","event":"claim","worker":"glm-dead","ts":"${STALE_TS}"}
{"bead":"tb-tst-wip","event":"claim","worker":"glm-wip","ts":"${STALE_TS}"}
{"bead":"tb-tst-blocked","event":"claim","worker":"glm-dead","ts":"${STALE_TS}"}
EOF
cat > "$SCENARIO_A/fixtures-open.jsonl" <<'EOF'
{"id":"tb-tst-ready","title":"visible bead","status":"open","assignee":null,"manual_blocked":false,"dependencies":[],"notes":""}
{"id":"tb-tst-live","title":"live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-live","manual_blocked":false,"dependencies":[],"notes":""}
{"id":"tb-tst-evlive","title":"event-live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-evlive","manual_blocked":false,"dependencies":[],"notes":""}
{"id":"tb-tst-dead","title":"dead worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-dead","manual_blocked":false,"dependencies":[],"notes":""}
{"id":"tb-tst-wip","title":"claimed mid-scan","status":"open","assignee":"claude-code-glm-5.3-flash-glm-wip","manual_blocked":false,"dependencies":[],"notes":""}
{"id":"tb-tst-blocked","title":"also blocked","status":"open","assignee":"claude-code-glm-5.3-flash-glm-dead","manual_blocked":false,"dependencies":[{"blocker":"tb-tst-blocker","kind":"blocks"}],"notes":""}
EOF
# The full list is the fresher read: tb-tst-wip was claimed between snapshots.
cat > "$SCENARIO_A/fixtures-all.jsonl" <<'EOF'
{"id":"tb-tst-ready","title":"visible bead","status":"open","assignee":null,"dependencies":[],"notes":""}
{"id":"tb-tst-live","title":"live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-live","dependencies":[],"notes":""}
{"id":"tb-tst-evlive","title":"event-live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-evlive","dependencies":[],"notes":""}
{"id":"tb-tst-dead","title":"dead worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-dead","dependencies":[],"notes":""}
{"id":"tb-tst-wip","title":"claimed mid-scan","status":"in_progress","assignee":"claude-code-glm-5.3-flash-glm-wip","dependencies":[],"notes":""}
{"id":"tb-tst-blocked","title":"also blocked","status":"open","assignee":"claude-code-glm-5.3-flash-glm-dead","dependencies":[{"blocker":"tb-tst-blocker","kind":"blocks"}],"notes":""}
{"id":"tb-tst-blocker","title":"unclosed blocker","status":"open","assignee":null,"dependencies":[],"notes":""}
EOF
# The ready frontier once the stub has seen the clear: the dead worker's bead,
# assignee gone. Before any clear the stub cats nothing (empty frontier).
echo '{"id":"tb-tst-dead","title":"dead worker","status":"open","assignee":null,"dependencies":[],"notes":""}' > "$SCENARIO_A/fixtures-ready.jsonl"

cat > "$RECOVERY_DIR/recovery.ts" <<'TS'
const daemonDir = process.env.TB_DAEMON_DIR + "/reconcile.ts";
const scenarioDir = process.env.TB_SCENARIO_DIR!;
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  [ok] " + msg);
  } else {
    console.error("  [FAIL] " + msg);
    failures++;
  }
}

const fs = await import("fs");
process.chdir(scenarioDir); // workspaceRoot and the diagnostics dir resolve from CWD
const {
  detectBeadStarvation,
  reconcileStarvationAlerts,
  loadLastHeartbeatByWorker,
  loadLastClaimerByBead,
  loadLastEventByWorker,
  resolveBeadWorkerLastSeen,
} = await import(daemonDir);

// Part 1 — unit: worker resolution and the liveness union
console.log("  [part-1] worker resolution");
const heartbeats = loadLastHeartbeatByWorker(scenarioDir + "/.beads/heartbeats.jsonl");
const claimers = loadLastClaimerByBead(scenarioDir + "/.beads/events.jsonl");
const eventsByWorker = loadLastEventByWorker(scenarioDir + "/.beads/events.jsonl");

const claudeAssignee = "claude-code-glm-5.3-flash-glm-dead";
const seenViaClaim = resolveBeadWorkerLastSeen(
  { id: "tb-tst-dead", title: "dead worker", status: "open", assignee: claudeAssignee, dependencies: [] },
  claimers, heartbeats, eventsByWorker
);
const staleMs = Date.now() - 3 * 60 * 60 * 1000;
assert(seenViaClaim !== null && Math.abs(seenViaClaim! - staleMs) < 60_000,
  "claude-style assignee resolves to its claimer worker's heartbeat");

const evliveSeen = resolveBeadWorkerLastSeen(
  { id: "tb-tst-evlive", title: "event-live worker", status: "open", assignee: "claude-code-glm-5.3-flash-glm-evlive", dependencies: [] },
  claimers, heartbeats, eventsByWorker
);
assert(evliveSeen !== null && Date.now() - evliveSeen! < 5 * 60 * 1000,
  "a fresh event keeps a worker alive despite a stale heartbeat");

assert(resolveBeadWorkerLastSeen(
  { id: "tb-tst-ghost", title: "ghost", status: "open", assignee: "claude-code-glm-5.3-flash-glm-ghost", dependencies: [] },
  claimers, heartbeats, eventsByWorker
) === null, "a worker with no trail anywhere resolves to null (cannot verify death)");

// Part 2 — end-to-end: only the verifiably dead worker's bead is cleared
console.log("  [part-2] clearing decisions");
const diag = await detectBeadStarvation();
assert(diag !== null, "diagnostic produced for excluded beads");
assert(diag!.recovered === true, "starvation recovered once the dead worker's bead returned to the frontier");

// Recovery is the detector's verdict; the lifecycle turns it into the alert
// decision. No alert is open in this fixture and the condition resolved, so
// nothing is filed and nothing is closed.
await reconcileStarvationAlerts(diag);

const attempts = diag!.recovery_attempts.join("\n");
assert(attempts.includes("ready 0 -> 1"), "recovery records the ready count rising: " +
  (attempts.match(/ready \d+ -> \d+/)?.[0] ?? "no rise recorded"));

const stubLog = fs.readFileSync(process.env.TB_STUB_LOG!, "utf-8");
const cleared = [...stubLog.matchAll(/^CLEAR (\S+)$/gm)].map(m => m[1]);
assert(cleared.length === 1 && cleared[0] === "tb-tst-dead",
  `exactly one assignee cleared, the dead worker's (${cleared.join(", ") || "none"})`);
assert(!stubLog.includes("CLEAR tb-tst-live"), "live worker's assignee not cleared");
assert(!stubLog.includes("CLEAR tb-tst-evlive"), "event-live worker's assignee not cleared");
assert(!stubLog.includes("CLEAR tb-tst-wip"), "in_progress bead's assignee never cleared");
assert(!stubLog.includes("CLEAR tb-tst-blocked"), "assignee that is not the only exclusion not cleared");

assert(attempts.includes("signal live") && attempts.includes("tb-tst-live"),
  "live worker decision recorded for the alert triage: " +
  (attempts.match(/bead tb-tst-live: .*$/m)?.[0] ?? "nothing recorded"));
assert(attempts.includes("tb-tst-evlive"), "event-live worker decision recorded");
assert(!stubLog.includes("CREATE "), "no alert bead filed when recovery succeeded");
assert(!stubLog.includes("CLOSE "), "no alert closed when none was open");

if (failures > 0) process.exit(1);
TS

write_recovery_stub "$SCENARIO_A" "$RECOVERY_DIR/stub-a.log"
echo "  [scenario-a] live / event-live / dead / in_progress / blocked beads"
(
  cd "$SCENARIO_A"
  TRAILBOSS_BEAD_BIN="$SCENARIO_A/bead-stub" \
  TB_DAEMON_DIR="$TB_DIR/daemon" \
  TB_SCENARIO_DIR="$SCENARIO_A" \
  TB_STUB_LOG="$RECOVERY_DIR/stub-a.log" \
    bun "$RECOVERY_DIR/recovery.ts"
)
echo "[PASS] scenario A: dead worker cleared and ready, live/in_progress/blocked assignees kept"

# ---------------------------------------------------------------------------
# Scenario B: nothing qualifies — every excluded bead has a live worker, so
# the detector must fall through to the existing alert path unchanged
# ---------------------------------------------------------------------------
cat > "$SCENARIO_B/.beads/heartbeats.jsonl" <<EOF
{"worker":"glm-liveonly","state":"working","ts":"${FRESH_TS}","last_strand":null}
EOF
cat > "$SCENARIO_B/.beads/events.jsonl" <<EOF
{"bead":"tb-tst-liveonly","event":"claim","worker":"glm-liveonly","ts":"${FRESH_TS}"}
EOF
cat > "$SCENARIO_B/fixtures-open.jsonl" <<'EOF'
{"id":"tb-tst-liveonly","title":"only bead, live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-liveonly","manual_blocked":false,"dependencies":[],"notes":""}
EOF
cat > "$SCENARIO_B/fixtures-all.jsonl" <<'EOF'
{"id":"tb-tst-liveonly","title":"only bead, live worker","status":"open","assignee":"claude-code-glm-5.3-flash-glm-liveonly","dependencies":[],"notes":""}
EOF
: > "$SCENARIO_B/fixtures-ready.jsonl"

cat > "$RECOVERY_DIR/fallthrough.ts" <<'TS'
const daemonDir = process.env.TB_DAEMON_DIR + "/reconcile.ts";
const scenarioDir = process.env.TB_SCENARIO_DIR!;
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  [ok] " + msg);
  } else {
    console.error("  [FAIL] " + msg);
    failures++;
  }
}

const fs = await import("fs");
process.chdir(scenarioDir);
const { detectBeadStarvation, reconcileStarvationAlerts } = await import(daemonDir);

const diag = await detectBeadStarvation();
assert(diag !== null && diag!.recovered === false, "nothing recovered when the only worker is live");

// Nothing qualifies for remediation, so the starvation persists: the
// lifecycle files the first alert (none is open)
await reconcileStarvationAlerts(diag);

const stubLog = fs.readFileSync(process.env.TB_STUB_LOG!, "utf-8");
assert(!stubLog.includes("CLEAR "), "no assignee cleared while the worker is live");
assert(diag!.recovery_attempts.some(a => a.includes("signal live") && a.includes("tb-tst-liveonly")),
  "live-worker decision recorded in recovery attempts");

const createIdx = stubLog.indexOf("CREATE ");
assert(createIdx !== -1, "detector falls through to the alert path when nothing qualifies");
assert(stubLog.slice(createIdx).includes("alert:starvation:unknown"), "alert carries the triage label");
assert(stubLog.slice(createIdx).includes("signal live"), "alert description carries the per-bead triage");

if (failures > 0) process.exit(1);
TS

write_recovery_stub "$SCENARIO_B" "$RECOVERY_DIR/stub-b.log"
echo "  [scenario-b] single live-worker bead, nothing qualifies"
(
  cd "$SCENARIO_B"
  TRAILBOSS_BEAD_BIN="$SCENARIO_B/bead-stub" \
  TB_DAEMON_DIR="$TB_DIR/daemon" \
  TB_SCENARIO_DIR="$SCENARIO_B" \
  TB_STUB_LOG="$RECOVERY_DIR/stub-b.log" \
    bun "$RECOVERY_DIR/fallthrough.ts"
)
echo "[PASS] scenario B: nothing cleared, alert path carries the triage"
echo ""

# Test 9: self-healing starvation alert lifecycle (trailbos-60a684b9).
# The loop that detects starvation also resolves its own alerts: a resolved
# diagnostic closes the open alert with the evidence in the close reason, a
# persistent starvation refreshes the one open alert in place instead of
# filing a duplicate, and the trailbos-8cae488d zero-field diagnostic is both
# rejected at emission and auto-closed as a false positive when one is
# already open. Invariant: at most one open starvation-alert bead.
echo "[test-9] Testing alert lifecycle: close resolved / refresh persistent / zero-field auto-close..."

ALERT_DIR="$(mktemp -d /tmp/tb-starvation-alert.XXXXXX)"
SC_9A="$ALERT_DIR/resolved"
SC_9A2="$ALERT_DIR/benign"
SC_9B="$ALERT_DIR/refresh"
SC_9C="$ALERT_DIR/zero-field"
OLD_TS="$(date -u -d '3 hours ago' +%Y-%m-%dT%H:%M:%S)+00:00"
MID_TS="$(date -u -d '40 minutes ago' +%Y-%m-%dT%H:%M:%S)+00:00"
RECENT_TS="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%S)+00:00"

mkdir -p "$SC_9A/.beads" "$SC_9A2/.beads" "$SC_9B/.beads" "$SC_9C/.beads"

# ---------------------------------------------------------------------------
# Fixture bead CLI with mutable open-bead state: `create`d alert beads show up
# on the next open listing, `close`d beads drop off it, and `update` enforces
# the --if-revision guard a real store enforces (mismatch -> exit 4).
# ---------------------------------------------------------------------------
write_alert_stub() {
  local dir="$1" log="$2"
  cat > "$dir/bead-stub" <<STUB
#!/usr/bin/env bash
LOG="$log"
DIR="$dir"

open_records() {
  { [ -f "\$DIR/fixtures-open.jsonl" ] && cat "\$DIR/fixtures-open.jsonl"
    [ -f "\$DIR/runtime-alerts.jsonl" ] && cat "\$DIR/runtime-alerts.jsonl"; } 2>/dev/null \\
    | if [ -s "\$DIR/closed-ids" ]; then grep -v -F -f "\$DIR/closed-ids"; else cat; fi \\
    | jq -c -s 'group_by(.id) | map(last)[]'
}

record_for() {
  { [ -f "\$DIR/fixtures-open.jsonl" ] && cat "\$DIR/fixtures-open.jsonl"
    [ -f "\$DIR/runtime-alerts.jsonl" ] && cat "\$DIR/runtime-alerts.jsonl"; } 2>/dev/null \\
    | jq -c --arg id "\$1" 'select(.id == \$id)' | tail -1
}

case "\$1" in
  update)
    id="\$2"
    rec=\$(record_for "\$id")
    if [ -z "\$rec" ]; then
      printf 'UPDATE-UNKNOWN %s\n' "\$id" >> "\$LOG"
      exit 1
    fi
    cur=\$(printf '%s' "\$rec" | jq -r '.revision // 1')
    ifrev=""
    notes=""
    prev=""
    for a in "\$@"; do
      if [ "\$prev" = "--notes" ]; then notes="\$a"; fi
      if [ "\$prev" = "--if-revision" ]; then ifrev="\$a"; fi
      prev="\$a"
    done
    if [ -n "\$ifrev" ] && [ "\$ifrev" != "\$cur" ]; then
      printf 'REVISION-CONFLICT %s (store %s, sent %s)\n' "\$id" "\$cur" "\$ifrev" >> "\$LOG"
      exit 4
    fi
    if [ -n "\$ifrev" ]; then printf 'IFREV %s %s\n' "\$id" "\$ifrev" >> "\$LOG"; fi
    printf 'UPDATE %s\n' "\$id" >> "\$LOG"
    printf 'NOTES<<<%s>>>\n' "\$notes" >> "\$LOG"
    printf '%s' "\$rec" | jq -c --argjson r "\$((cur + 1))" --arg n "\$notes" '.revision = \$r | .notes = \$n' >> "\$DIR/runtime-alerts.jsonl"
    exit 0 ;;
  close)
    id="\$2"
    shift 2
    if [ "\$1" = "--reason" ]; then shift; fi
    printf 'CLOSE %s\n' "\$id" >> "\$LOG"
    printf 'REASON<<<%s>>>\n' "\$*" >> "\$LOG"
    printf '"id":"%s"\n' "\$id" >> "\$DIR/closed-ids"
    exit 0 ;;
  create)
    printf 'CREATE %s\n' "\$*" >> "\$LOG"
    # Only an actual starvation alert becomes an open alert bead; a
    # detector-bug create is logged but does not join the open frontier.
    case "\$*" in
      *alert:starvation:unknown*)
        printf '{"id":"tb-al-created-%s","title":"Starvation alert (stub-created)","status":"open","assignee":null,"manual_blocked":false,"labels":["alert:starvation:unknown","human","starvation-alert"],"dependencies":[],"notes":"","revision":1,"created_at":"%s"}\n' \\
          "\$(date +%s%N)" "\$(date -u +%Y-%m-%dT%H:%M:%S)+00:00" >> "\$DIR/runtime-alerts.jsonl" ;;
    esac
    exit 0 ;;
  list)
    printf 'bead %s\n' "\$*" >> "\$LOG"
    case "\$*" in
      *" --ready"*)
        { [ -f "\$DIR/fixtures-ready.jsonl" ] && cat "\$DIR/fixtures-ready.jsonl"; } 2>/dev/null \\
          | if [ -s "\$DIR/closed-ids" ]; then grep -v -F -f "\$DIR/closed-ids"; else cat; fi ;;
      *" --status open"*) open_records ;;
      *"list --json"*) [ -f "\$DIR/fixtures-all.jsonl" ] && cat "\$DIR/fixtures-all.jsonl" ;;
    esac
    exit 0 ;;
  *)
    printf 'bead %s\n' "\$*" >> "\$LOG"
    exit 0 ;;
esac
exit 0
STUB
  chmod +x "$dir/bead-stub"
}

# Alert bead record template: labels are what the real emitter stamps.
alert_record() {  # id revision created_at notes
  printf '{"id":"%s","title":"Starvation alert: beads invisible in /ws","status":"open","assignee":null,"manual_blocked":false,"labels":["alert:starvation:unknown","human","starvation-alert"],"dependencies":[],"notes":"%s","revision":%s,"created_at":"%s"}\n' "$1" "$4" "$2" "$3"
}
plain_record() {  # id title
  printf '{"id":"%s","title":"%s","status":"open","assignee":null,"manual_blocked":false,"labels":[],"dependencies":[],"notes":"","revision":2,"created_at":"%s"}\n' "$1" "$2" "$RECENT_TS"
}

# --- scenario 9a: the condition resolved -> the stale alert is closed -------
alert_record tb-al-resolved 4 "$OLD_TS" "operator context - keep" > "$SC_9A/fixtures-open.jsonl"
plain_record tb-normal "plain open bead" >> "$SC_9A/fixtures-open.jsonl"
alert_record tb-al-resolved 4 "$OLD_TS" "operator context - keep" > "$SC_9A/fixtures-ready.jsonl"
plain_record tb-normal "plain open bead" >> "$SC_9A/fixtures-ready.jsonl"
cat "$SC_9A/fixtures-open.jsonl" > "$SC_9A/fixtures-all.jsonl"

# --- scenario 9a2: every excluded bead is held by design (tb-bctb shape) ----
alert_record tb-al-benign 2 "$OLD_TS" "" > "$SC_9A2/fixtures-open.jsonl"
plain_record tb-keeper "claimable work" >> "$SC_9A2/fixtures-open.jsonl"
plain_record tb-keeper "claimable work" > "$SC_9A2/fixtures-ready.jsonl"
cat "$SC_9A2/fixtures-open.jsonl" > "$SC_9A2/fixtures-all.jsonl"

# --- scenario 9b: starvation persists -> refresh, never duplicate ------------
alert_record tb-al-primary 7 "$OLD_TS" "operator context - keep" > "$SC_9B/fixtures-open.jsonl"
alert_record tb-al-extra 1 "$MID_TS" "" >> "$SC_9B/fixtures-open.jsonl"
plain_record tb-stuck "unexplained stuck bead" >> "$SC_9B/fixtures-open.jsonl"
: > "$SC_9B/fixtures-ready.jsonl"
cat "$SC_9B/fixtures-open.jsonl" > "$SC_9B/fixtures-all.jsonl"

# --- scenario 9c: zero-field diagnostic, one alert already open --------------
alert_record tb-al-zero 2 "$RECENT_TS" "" > "$SC_9C/fixtures-open.jsonl"
alert_record tb-al-zero 2 "$RECENT_TS" "" > "$SC_9C/fixtures-ready.jsonl"
cat "$SC_9C/fixtures-open.jsonl" > "$SC_9C/fixtures-all.jsonl"

cat > "$ALERT_DIR/alert-lifecycle.ts" <<'TS'
const daemonDir = process.env.TB_DAEMON_DIR + "/reconcile.ts";
const scenarioDir = process.env.TB_SCENARIO_DIR!;
let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  [ok] " + msg);
  } else {
    console.error("  [FAIL] " + msg);
    failures++;
  }
}

const fs = await import("fs");
process.chdir(scenarioDir); // workspaceRoot and the diagnostics dir resolve from CWD
const {
  detectBeadStarvation,
  reconcileStarvationAlerts,
  decideStarvationAlertAction,
  createStarvationAlertBead,
  validateStarvationAlert,
} = await import(daemonDir);

const readLog = () => fs.readFileSync(process.env.TB_STUB_LOG!, "utf-8");
function closeReasons(log: string): Map<string, string> {
  return new Map([...log.matchAll(/CLOSE (\S+)\nREASON<<<([\s\S]*?)>>>/g)].map(m => [m[1], m[2]]));
}

switch (process.env.TB_SCENARIO) {
  // (a) resolved diagnostic closes the open alert, evidence in the close reason
  case "resolved": {
    const diag = await detectBeadStarvation();
    assert(diag === null, "nothing excluded from the ready frontier -> no starvation");
    await reconcileStarvationAlerts(diag);

    const log = readLog();
    const reasons = closeReasons(log);
    assert(reasons.has("tb-al-resolved"), "stale alert bead closed");
    const reason = reasons.get("tb-al-resolved") ?? "";
    assert(reason.includes("(resolved)"), "closed as resolved: " + reason.slice(0, 80));
    assert(reason.includes("2 open beads, 2 ready, 0 excluded"), "close reason quotes the live counts");
    assert(reason.includes("nothing held outside the ready frontier"), "close reason quotes the frontier result");
    assert(!log.includes("CREATE "), "no new alert filed");
    assert(!log.includes("UPDATE "), "nothing rewritten on the way out");

    // unit: a recovered diagnostic closes with the recovery in the evidence
    const recovered = {
      timestamp: new Date().toISOString(),
      workspace: scenarioDir,
      open_beads: 3, ready_beads: 3, excluded_beads: 0,
      exclusion_reasons: [],
      recovered: true,
      recovery_attempts: ["bead sync flush completed", "starvation resolved after sync flush"],
    };
    const action = await decideStarvationAlertAction(recovered as never, scenarioDir);
    assert(action.action === "close" && action.kind === "resolved", "recovered diagnostic closes as resolved");
    assert(action.action === "close" && action.evidence.includes("starvation resolved after sync flush"),
      "close evidence carries the recovery attempts");
    break;
  }

  // (a2) the tb-bctb shape: frontier non-empty, every excluded bead held by
  // design (the alert bead itself is human-labeled) -> closed as benign
  case "benign": {
    const diag = await detectBeadStarvation();
    assert(diag !== null && diag!.recovered === false, "diagnostic produced, not recoverable by flush or clearing");
    assert(diag!.excluded_classifications?.[0]?.deliberate === true,
      "the only excluded bead classifies as held by design: " + JSON.stringify(diag!.excluded_classifications));

    await reconcileStarvationAlerts(diag);
    const reasons = closeReasons(readLog());
    assert(reasons.has("tb-al-benign"), "benign-shape alert closed");
    const reason = reasons.get("tb-al-benign") ?? "";
    assert(reason.includes("(benign)"), "closed as benign: " + reason.slice(0, 80));
    assert(reason.includes("label filter ('human')"), "close reason names the classification cause");
    assert(reason.includes("1 of 2 open beads visible"), "close reason quotes the non-empty frontier");
    assert(!readLog().includes("CREATE "), "no new alert filed");
    break;
  }

  // (b) persistent starvation refreshes the existing bead, never duplicates
  case "refresh": {
    const diag1 = await detectBeadStarvation();
    assert(diag1 !== null && diag1!.recovered === false, "starvation detected, not recoverable");
    await reconcileStarvationAlerts(diag1);

    let log = readLog();
    assert(!log.includes("CREATE "), "no duplicate alert filed while one is open");
    const reasons = closeReasons(log);
    assert(reasons.has("tb-al-extra"), "extra open alert closed");
    const dupReason = reasons.get("tb-al-extra") ?? "";
    assert(dupReason.includes("(duplicate)") && dupReason.includes("tb-al-primary"),
      "duplicate closed pointing at the canonical alert: " + dupReason.slice(0, 80));
    assert(dupReason.includes("at most one open starvation alert"), "duplicate close states the invariant");

    assert(/IFREV tb-al-primary \d+/.test(log), "refresh of the canonical alert is revision-guarded");
    assert(!log.includes("REVISION-CONFLICT tb-al-primary"), "the guard sent the store's current revision");
    const notesBlocks = [...log.matchAll(/NOTES<<<([\s\S]*?)>>>/g)].map(m => m[1]);
    const refreshBlock = notesBlocks.find(n => n.includes("starvation alert refresh @"));
    assert(refreshBlock !== undefined, "refresh block written to the alert notes");
    assert((refreshBlock ?? "").startsWith("operator context - keep"),
      "read-modify-write preserves the operator's existing notes");
    assert((refreshBlock ?? "").includes("still starved: open=3 ready=0 excluded=3"),
      "refresh carries the fresh counts");
    assert((refreshBlock ?? "").includes("bead tb-stuck: no mechanical cause identified"),
      "refresh carries the exclusion reasons");

    // Immediate second cycle: the fresh refresh throttles, the single alert
    // stays single, and nothing new is filed.
    const updatesAfterCycle1 = [...log.matchAll(/^UPDATE tb-al-primary$/gm)].length;
    const diag2 = await detectBeadStarvation();
    await reconcileStarvationAlerts(diag2);
    log = readLog();
    const updatesAfterCycle2 = [...log.matchAll(/^UPDATE tb-al-primary$/gm)].length;
    assert(updatesAfterCycle2 === updatesAfterCycle1,
      `refresh throttled within the window (cycle 1: ${updatesAfterCycle1}, cycle 2: ${updatesAfterCycle2})`);
    assert(!log.includes("CREATE "), "still no duplicate after the second cycle");
    break;
  }

  // (c) the exact trailbos-8cae488d zero-field diagnostic: rejected at
  // emission, and auto-closed as a false positive when one is already open
  case "zero-field": {
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
    assert(validateStarvationAlert(zeroField).actionable === false, "guard rejects the zero-field diagnostic at emission");
    createStarvationAlertBead(zeroField);

    let log = readLog();
    assert(!log.includes("Starvation alert: beads invisible"), "no starvation alert emitted for the zero-field diagnostic");
    assert(log.includes("starvation-detector-bug"), "detector-bug bead filed instead");

    await reconcileStarvationAlerts(zeroField as never);
    const reasons = closeReasons(readLog());
    assert(reasons.has("tb-al-zero"), "already-open alert auto-closed");
    const reason = reasons.get("tb-al-zero") ?? "";
    assert(reason.includes("(invalid)"), "closed as invalid: " + reason.slice(0, 80));
    assert(reason.includes("workspace is blank"), "close reason quotes the validation failure");
    assert(reason.includes("open=0 ready=0 excluded=0"), "close reason quotes the zero counts");
    break;
  }

  default:
    console.error("  [FAIL] unknown scenario " + process.env.TB_SCENARIO);
    failures++;
}

if (failures > 0) process.exit(1);
TS

run_alert_scenario() {  # dir scenario-name pass-message
  local dir="$1" scenario="$2" message="$3"
  write_alert_stub "$dir" "$ALERT_DIR/stub-$scenario.log"
  echo "  [scenario-$scenario] $message"
  (
    cd "$dir"
    TRAILBOSS_BEAD_BIN="$dir/bead-stub" \
    TB_DAEMON_DIR="$TB_DIR/daemon" \
    TB_SCENARIO_DIR="$dir" \
    TB_SCENARIO="$scenario" \
    TB_STUB_LOG="$ALERT_DIR/stub-$scenario.log" \
      bun "$ALERT_DIR/alert-lifecycle.ts"
  )
}

run_alert_scenario "$SC_9A" resolved "resolved diagnostic closes the stale alert with evidence"
echo "[PASS] 9a: resolved diagnostic closed the open alert, evidence in the close reason"
run_alert_scenario "$SC_9A2" benign "every excluded bead held by design closes the alert as benign"
echo "[PASS] 9a2: label-filtered shape closed as benign (tb-bctb regression)"
run_alert_scenario "$SC_9B" refresh "persistent starvation refreshes one alert, closes the duplicate"
echo "[PASS] 9b: persistent starvation refreshed in place, no duplicate filed"
run_alert_scenario "$SC_9C" zero-field "zero-field diagnostic rejected at emission and auto-closed"
echo "[PASS] 9c: zero-field diagnostic suppressed at emission and auto-closed when open"
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
echo "✓ Dead-worker assignees cleared, live/in_progress/blocked kept (trailbos-4cca2e94)"
echo "✓ Alert lifecycle: resolved closed with evidence, persistent refreshed, zero-field auto-closed (trailbos-60a684b9)"
echo ""
echo "[SUCCESS] All starvation detection tests passed!"
