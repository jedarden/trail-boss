# tb-5n9: Tmux-level Fallback Detector

## Status: COMPLETE

This bead validated the harness-agnostic adapter seam by implementing a second adapter (tmux detector) to prove the abstraction works for harnesses without hooks.

## Implementation

The tmux detector was fully implemented in prior beads:

- **Core detector**: `daemon/tmux-detector.ts` (460 lines, TypeScript/Bun)
  - Polls opted-in panes (title prefix `@tb-`) every 2 seconds
  - Detects stuck state when pane output is quiet for 30+ seconds at a prompt
  - Emits normalized events to daemon's `/event/normalized` endpoint
  - Graceful shutdown with signal handlers

- **Wrapper script**: `bin/trailboss-tmux-detector`
  - Convenience wrapper for running the detector
  - Handles help and argument forwarding

- **Acceptance test**: `test-tmux-detector.sh`
  - Creates isolated tmux server with test pane
  - Verifies stuck detection, queue entry, and unstuck behavior
  - Uses 3-second quiet threshold for faster testing

## Viability Verdict: **PRODUCTION-READY**

Per `docs/notes/decisions.md` section "Tmux Detector Viability (2026-07-02)":

- **False positive rate**: Low (30s threshold + prompt patterns)
- **False negative rate**: User-dependent (requires `@tb-` prefix)
- **Performance impact**: Minimal (2s poll, <50ms per cycle)
- **Test results**: 100% pass rate across 5 consecutive runs (14.2s avg duration)

## Design Decision

The `/event/normalized` endpoint was added to accept pre-normalized events directly from harness-agnostic adapters. This keeps the adapter layer at the emission site (hook script or detector) rather than in the daemon.

**Alternative considered**: Server-side adapter wrapper for multiple event formats
**Chosen approach**: Dedicated normalized endpoint (cleaner separation, protocol simplicity, extensibility)

## Plan Open Question 1: RESOLVED

**Question**: Is a purely tmux-level detector (no hooks) viable as a universal fallback for harnesses without hooks?

**Answer**: Yes. The tmux detector successfully implements harness-agnostic stuck detection with acceptable reliability and performance. For Claude Code, hook-based detection remains primary (full fidelity, zero latency), but the detector enables Trail Boss to work with any future harness lacking hooks.

Resolution recorded in `docs/plan/plan.md` line 667.

## Related Beads

- tb-1me: Initial acceptance test implementation
- tb-163k: Additional test iterations and investigation
- tb-4l7s: Final viability verdict and documentation
