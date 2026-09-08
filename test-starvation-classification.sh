#!/usr/bin/env bash
# Test mechanical classification of excluded beads (trailbos-ba86503f).
#
# detectBeadStarvation() diffs the open/ready ID sets and, for every excluded
# bead, derives its invisibility cause from bead data alone: manual_blocked,
# in_progress + worker heartbeat, dead assignee, or unclosed blockers. This
# test exercises the classifier directly (fixtures) and end-to-end through
# detectBeadStarvation() with a stubbed bead CLI, and checks that the
# classification reaches the bead's notes appended — never replacing — and
# only once per distinct cause-set.
set -e

TB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGRESSION_DIR="$(mktemp -d /tmp/tb-starvation-classify.XXXXXX)"
STUB_LOG="$REGRESSION_DIR/bead-stub.log"

# Add bun to PATH
export PATH="$HOME/.bun/bin:$PATH"

cleanup() {
  echo "[cleanup] tearing down..."
  rm -rf "$REGRESSION_DIR" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$REGRESSION_DIR/.beads"

# ---------------------------------------------------------------------------
# Fixture bead CLI: answers `bead list` from files the TS script writes,
# records update/create. `update` notes are multi-line, so they are logged
# between delimiters rather than as one line.
# ---------------------------------------------------------------------------
cat > "$REGRESSION_DIR/bead-stub" <<STUB
#!/usr/bin/env bash
LOG="$STUB_LOG"
if [ "\$1" = "update" ]; then
  printf 'UPDATE %s\n' "\$2" >> "\$LOG"
  printf 'NOTES<<<%s>>>\n' "\$4" >> "\$LOG"
  exit 0
fi
if [ "\$1" = "create" ]; then
  printf 'CREATE %s\n' "\$*" >> "\$LOG"
  exit 0
fi
printf 'bead %s\n' "\$*" >> "\$LOG"
case "\$*" in
  *"--status open"*) cat "\$TB_FIXTURE_OPEN" ;;
  *"--ready"*) cat "\$TB_FIXTURE_READY" ;;
  *"list --json"*) cat "\$TB_FIXTURE_ALL" ;;
esac
exit 0
STUB
chmod +x "$REGRESSION_DIR/bead-stub"

# Heartbeat 90s old so the age renders deterministically as "1m". The offset
# suffix matters: the box runs EDT, and a timezone-less stamp would be parsed
# as local time — four hours into the future.
HB_TS="$(date -u -d '90 seconds ago' +%Y-%m-%dT%H:%M:%S)+00:00"
cat > "$REGRESSION_DIR/.beads/heartbeats.jsonl" <<EOF
{"worker":"glm-alpha","state":"working","ts":"2026-09-01T00:00:00+00:00","last_strand":null}
{"worker":"glm-wip","state":"idle","ts":"${HB_TS}","last_strand":null}
not json at all
EOF
cat > "$REGRESSION_DIR/.beads/events.jsonl" <<EOF
{"bead":"tb-wip","event":"dispatch","worker":"glm-wrong","ts":"2026-09-01T00:00:00+00:00"}
{"bead":"tb-wip","event":"claim","worker":"glm-wip","ts":"2026-09-01T00:00:00+00:00"}
EOF

cat > "$REGRESSION_DIR/classification.ts" <<'TS'
const daemonDir = process.env.TB_DAEMON_DIR + "/reconcile.ts";
const regressionDir = process.env.TB_REGRESSION_DIR!;
const {
  classifyExcludedBead,
  loadLastHeartbeatByWorker,
  loadLastClaimerByBead,
} = await import(daemonDir);
type BeadRecord = Parameters<typeof classifyExcludedBead>[0];

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log("  [ok] " + msg);
  } else {
    console.error("  [FAIL] " + msg);
    failures++;
  }
}

// ---------------------------------------------------------------------------
// Part 1 — unit tests: one classification branch per exclusion cause
// ---------------------------------------------------------------------------
console.log("[part-1] classifyExcludedBead branches");

const nowMs = Date.now();
const heartbeats = loadLastHeartbeatByWorker(regressionDir + "/.beads/heartbeats.jsonl");
const claimers = loadLastClaimerByBead(regressionDir + "/.beads/events.jsonl");
assert(heartbeats.size === 2, "heartbeat loader keeps last entry per worker and skips malformed lines");
assert(heartbeats.get("glm-wip")?.state === "idle", "last heartbeat for a worker wins");
assert(claimers.size === 1 && claimers.get("tb-wip")?.worker === "glm-wip", "claim loader keeps the claim event, ignores other events");

const statusById = new Map<string, string>([
  ["tb-blocker-open", "open"],
  ["tb-blocker-closed", "closed"],
]);

function classify(bead: BeadRecord) {
  return classifyExcludedBead(bead, statusById, heartbeats, claimers, nowMs);
}

// (d) manual_blocked is deliberate and ends the classification
const manual = classify({ id: "tb-manual", title: "manual", status: "open", manual_blocked: true, dependencies: [] });
assert(manual.causes.length === 1 && manual.causes[0].includes("manually blocked"), "manual_blocked classifies as deliberate");
assert(manual.known === true, "manual_blocked is a known cause");

// (a) in_progress reports the worker heartbeat with state and age; the
// assignee name never matches a heartbeat worker here, so the claim event
// bridges the two namespaces
const wip = classify({ id: "tb-wip", title: "wip", status: "in_progress", assignee: "claude-someone", dependencies: [] });
assert(wip.causes[0]?.includes("worker glm-wip"), "in_progress falls back to the claim-event worker: " + wip.causes[0]);
assert(wip.causes[0]?.includes("state=idle"), "in_progress reports heartbeat state");
assert(wip.causes[0]?.includes("1m ago"), "in_progress reports heartbeat age: " + wip.causes[0]);

// (a) direct assignee->worker match beats the claim event
const wipDirect = classify({ id: "tb-direct", title: "direct", status: "in_progress", assignee: "glm-alpha", dependencies: [] });
assert(wipDirect.causes[0]?.includes("worker glm-alpha"), "in_progress prefers the assignee's own heartbeat when names match");

// (a) in_progress whose worker has no heartbeat anywhere
const wipNoHb = classify({ id: "tb-wip2", title: "wip2", status: "in_progress", assignee: "claude-ghost", dependencies: [] });
assert(wipNoHb.causes[0]?.includes("no heartbeat recorded"), "in_progress without any heartbeat says so: " + wipNoHb.causes[0]);

// (b) open + assignee is a dead-assignee candidate
const assigned = classify({ id: "tb-assigned", title: "assigned", status: "open", assignee: "alice", dependencies: [] });
assert(assigned.causes.some(c => c.includes("dead-assignee candidate") && c.includes("alice")), "open+assignee is a dead-assignee candidate");

// (c) unclosed blockers are listed with status; closed ones are not
const blocked = classify({
  id: "tb-blocked", title: "blocked", status: "open",
  dependencies: [
    { blocker: "tb-blocker-open", kind: "blocks" },
    { blocker: "tb-blocker-closed", kind: "blocks" },
    { blocker: "tb-related", kind: "relates_to" },
  ],
});
assert(blocked.causes.some(c => c.includes("blocked by tb-blocker-open (open)")), "unclosed blocker listed with its status");
assert(!blocked.causes.some(c => c.includes("tb-blocker-closed")), "closed blocker not listed");
assert(!blocked.causes.some(c => c.includes("tb-related")), "relates_to edges are not blockers");

// unknown: open, unassigned, unblocked — the alert:starvation:unknown residue
const unknown = classify({ id: "tb-mystery", title: "mystery", status: "open", dependencies: [] });
assert(unknown.known === false && unknown.causes[0].includes("no mechanical cause identified"), "unexplained exclusion is flagged unknown");

// ---------------------------------------------------------------------------
// Part 2 — end-to-end: detectBeadStarvation over the stubbed CLI
// ---------------------------------------------------------------------------
console.log("[part-2] detectBeadStarvation end-to-end");

const openBeads = [
  { id: "tb-ready", title: "visible bead", status: "open", assignee: null, manual_blocked: false, dependencies: [], notes: "" },
  { id: "tb-blocked", title: "blocked bead", status: "open", assignee: null, manual_blocked: false,
    dependencies: [{ blocker: "tb-blocker-open", kind: "blocks" }], notes: "operator note - keep me" },
  { id: "tb-assigned", title: "assigned bead", status: "open", assignee: "alice", manual_blocked: false, dependencies: [], notes: "" },
  { id: "tb-wip", title: "claimed mid-scan", status: "open", assignee: "claude-someone", manual_blocked: false, dependencies: [], notes: "" },
  // Excluded but mechanically unexplained: classified unknown, and per design
  // no note is stamped on the bead — an "unknown" note would read as if the
  // bead were fine to whoever finds it there; the unknown belongs on the alert
  { id: "tb-mystery", title: "unexplained", status: "open", assignee: null, manual_blocked: false, dependencies: [], notes: "" },
];
const readyBeads = [openBeads[0]];
const allBeads = [
  // Fresher than the open snapshot: tb-wip was claimed between the two
  // snapshots the detector takes, so the full list already shows in_progress
  ...openBeads.map(b => b.id === "tb-wip" ? { ...b, status: "in_progress" } : b),
  { id: "tb-blocker-open", title: "blocker", status: "open", assignee: null, dependencies: [], notes: "" },
];

const fs = await import("fs");
fs.writeFileSync(regressionDir + "/fixtures-open.jsonl", openBeads.map(b => JSON.stringify(b)).join("\n") + "\n");
fs.writeFileSync(regressionDir + "/fixtures-ready.jsonl", readyBeads.map(b => JSON.stringify(b)).join("\n") + "\n");
fs.writeFileSync(regressionDir + "/fixtures-all.jsonl", allBeads.map(b => JSON.stringify(b)).join("\n") + "\n");

process.chdir(regressionDir); // logStarvationDiagnostic writes under CWD
const { detectBeadStarvation, validateStarvationAlert } = await import(daemonDir);

const diag = await detectBeadStarvation();
assert(diag !== null, "diagnostic produced for a workspace with excluded beads");
assert(diag!.open_beads === 5 && diag!.ready_beads === 1 && diag!.excluded_beads === 4,
  `set-diff accounting: open=${diag!.open_beads} ready=${diag!.ready_beads} excluded=${diag!.excluded_beads}`);
assert(diag!.ready_beads + diag!.excluded_beads === diag!.open_beads, "counts add up for validateStarvationAlert");

const reasons = diag!.exclusion_reasons.join("\n");
assert(reasons.includes("bead tb-blocked: blocked by tb-blocker-open (open)"), "exclusion_reasons name the blocker cause");
assert(reasons.includes("bead tb-assigned: open but assigned to alice (dead-assignee candidate)"), "exclusion_reasons name the dead-assignee cause");
assert(reasons.includes("bead tb-wip: in_progress: worker glm-wip"), "exclusion_reasons name the in_progress cause via the fresher status");
assert(reasons.includes("bead tb-mystery: no mechanical cause identified"), "unexplained exclusion still reaches exclusion_reasons");
assert(!reasons.includes("bead tb-ready"), "ready beads are never given exclusion reasons");
assert(validateStarvationAlert(diag!).actionable === true, "classified diagnostic passes the alert guard");

// A second detection in the same process must not re-stamp unchanged causes
await detectBeadStarvation();

// ---------------------------------------------------------------------------
// Part 3 — stub invocations: notes appended, once per distinct cause-set
// ---------------------------------------------------------------------------
console.log("[part-3] notes append and dedup, from stub invocations");
const stubLog = fs.readFileSync(process.env.TB_STUB_LOG!, "utf-8");

const notesBlocks = [...stubLog.matchAll(/NOTES<<<([\s\S]*?)>>>/g)].map(m => m[1]);
// One note per classified bead (3 with identified causes), and none on the
// second detection whose cause-sets were unchanged
assert(notesBlocks.length === 3, `one note per classified bead across two detections (got ${notesBlocks.length})`);
assert(notesBlocks.some(n => n.startsWith("operator note - keep me")), "existing notes preserved ahead of the appended classification");
assert(notesBlocks.every(n => n.includes("starvation classification")), "classification appended to notes");
assert(!stubLog.includes("UPDATE tb-mystery"), "beads with no identified cause get no note");

const createIdx = stubLog.indexOf("CREATE ");
assert(createIdx !== -1, "alert bead filed for the unrecovered starvation");
assert(stubLog.slice(createIdx).includes("blocked by tb-blocker-open (open)"), "alert description names the classified cause");

if (failures > 0) process.exit(1);
TS

echo "[setup] running classification tests..."
(
  cd "$REGRESSION_DIR"
  TRAILBOSS_BEAD_BIN="$REGRESSION_DIR/bead-stub" \
  TB_DAEMON_DIR="$TB_DIR/daemon" \
  TB_REGRESSION_DIR="$REGRESSION_DIR" \
  TB_STUB_LOG="$STUB_LOG" \
  TB_FIXTURE_OPEN="$REGRESSION_DIR/fixtures-open.jsonl" \
  TB_FIXTURE_READY="$REGRESSION_DIR/fixtures-ready.jsonl" \
  TB_FIXTURE_ALL="$REGRESSION_DIR/fixtures-all.jsonl" \
    bun "$REGRESSION_DIR/classification.ts"
)

echo ""
echo "=== Test Summary ==="
echo "✓ Classification branches: manual_blocked / in_progress+heartbeat / dead assignee / unclosed blockers / unknown"
echo "✓ Heartbeat loader keeps last entry per worker, skips malformed lines"
echo "✓ Claim events bridge assignee names to heartbeat worker names"
echo "✓ exclusion_reasons carry the classified causes; ready beads excluded"
echo "✓ Classification notes append to existing notes, never replace"
echo "✓ Unchanged cause-sets are not re-stamped"
echo "✓ Alert description names the classified cause"
echo ""
echo "[SUCCESS] All starvation classification tests passed!"
