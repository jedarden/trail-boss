# Bead tb-4l7s: Tmux Detector Viability Verdict

**Bead ID**: tb-4l7s
**Status**: ✅ CLOSED
**Date**: 2026-07-03

## Task Summary

Run acceptance tests and record viability verdict for the tmux-level stuck detector to resolve Open question 1 in docs/plan/plan.md.

## Acceptance Criteria Met

1. ✅ **Test executed successfully**
   - 5/5 consecutive test runs PASSED
   - Average duration: 14.2s (std dev: 0.4s)
   - Zero false positives/negatives
   - All lifecycle stages validated (discovery, stuck detection, queue entry, unstuck, dequeue)

2. ✅ **Viability verdict recorded in docs/notes/decisions.md**
   - Section "Final Viability Confirmation (2026-07-03) — Bead tb-4l7s" (lines 553-634)
   - Verdict: **PRODUCTION-READY**
   - Comprehensive assessment of reliability, performance, and tuning

3. ✅ **docs/plan/plan.md Open question 1 marked as resolved**
   - Line 667: `**RESOLVED (2026-07-02):** Yes, a purely tmux-level detector is viable as a universal fallback...`

## Viability Verdict

**PRODUCTION-READY** — The tmux detector is confirmed viable as a universal fallback for harnesses without hooks.

### Key Findings

- **Reliability**: Zero false positives/negatives across 5 test runs
- **Performance**: Acceptable detection latency (30s quiet threshold), minimal CPU overhead (2s poll interval)
- **Noise Issues**: None observed
- **Tuning Applied**:
  - Quiet threshold: 30s (production) / 3s (testing)
  - Poll interval: 2s
  - Prompt patterns: 11 regex patterns for false positive filtering
  - Hash-based output comparison

### Recommendations

1. **Deploy with confidence**: Detector is ready for production use
2. **Use as fallback only**: Hook-based detection remains primary for Claude Code
3. **Operator opt-in required**: Users must set `@tb-` prefix on pane titles

## Test Results Summary

| Run | Status | Duration |
|-----|--------|----------|
| 1   | PASS   | 14s      |
| 2   | PASS   | 14s      |
| 3   | PASS   | 15s      |
| 4   | PASS   | 14s      |
| 5   | PASS   | 14s      |

**Pass Rate**: 100%
**Avg Duration**: 14.2s
**Std Deviation**: 0.4s

## Open Question 1 Resolution

**Question**: Is a purely tmux-level detector (no hooks) viable as a universal fallback for future harnesses?

**Answer**: YES — Implemented in `daemon/tmux-detector.ts` with opt-in via `@tb-` pane title prefix, 30s quiet threshold, and prompt pattern matching. Emits normalized events to daemon's `/event/normalized` endpoint. For Claude Code, hook-based detection remains primary (full fidelity, zero latency), but the detector enables Trail Boss to work with any future harness lacking hooks.

## Documentation

- **Full findings**: `docs/notes/decisions.md` — "Tmux Detector Viability" and "Final Viability Confirmation"
- **Acceptance test**: `test-tmux-detector-acceptance.sh`
- **Test results**: `/home/coding/trail-boss/test-results/` (various CSV and JSON files)

---

**Outcome**: All acceptance criteria met. Open question 1 resolved. Tmux detector confirmed production-ready as a universal fallback.
