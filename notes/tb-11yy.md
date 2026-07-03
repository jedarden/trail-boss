# Starvation Alert Root Cause Analysis (tb-11yy)

## Alert Summary

**Bead:** tb-11yy
**Message:** "Starvation alert: beads invisible to worker"
**Context:** Open beads exist but Pluck found none — possible configuration error

## Investigation Findings

### Database State (at time of alert)

| Metric | Count |
|--------|-------|
| Total beads | 60 |
| Open | 1 (`tb-5n9`) |
| In-progress | 1 (`tb-11yy` itself) |
| Closed | 58 |

### Root Cause

**The only open bead (`tb-5n9`) has the `deferred` label.**

Per NEEDLE's Pluck strand implementation (`NEEDLE/src/strand/pluck.rs:13`), the following labels are **excluded by default**:

```rust
const DEFAULT_EXCLUDE_LABELS: &[&str] = &["deferred", "human", "blocked", "starvation-alert"];
```

Additionally, Pluck filters out:
- Beads with status `in_progress` (tb-11yy itself)
- Open beads with an assignee (stale claims)

### Verdict

**This is expected behavior, NOT a configuration error.**

The bead `tb-5n9` ("Prototype tmux-level fallback detector") is part of Phase 9 implementation and was intentionally marked `deferred` (likely because Phase 8 TUI work takes priority). The NEEDLE worker correctly skips deferred beads.

### Why the Alert Was Generated

The NEEDLE worker's strand escalation logic detected that there were open beads in the workspace but Pluck returned `NoWork`. This triggered the automatic starvation alert (tb-11yy) with the `starvation-alert` label.

However, the alert bead itself inherits the `starvation-alert` label, meaning it will also be excluded from Pluck — which is correct, as we don't want starvation alerts to create an infinite loop of self-processing.

### Recommendation

**No action needed.** The system is working as designed. When `tb-5n9` is ready for work, remove the `deferred` label and the worker will claim it normally.

## Related

- NEEDLE Pluck implementation: `/home/coding/NEEDLE/src/strand/pluck.rs`
- Bead `tb-5n9`: Phase 9 tmux-level fallback detector
