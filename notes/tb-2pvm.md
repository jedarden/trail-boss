# Bead Worker Starvation Alert - tb-2pvm

## Issue
Open beads existed but Pluck (bead-worker) found none - appeared to be a configuration error.

## Investigation Summary

### Bead Count
- **Total beads**: 32
- **Open**: 9 (with empty assignee)
- **In-progress**: 1 (tb-3pt)
- **Actually claimable**: 0

### Root Cause
All 9 open beads have special labels that exclude them from `br claim`:

**With `deferred` label (3 beads):**
- tb-1me: "Run tmux detector acceptance tests and gather metrics" (deferred, split-child, umbrella)
- tb-23i: "Record tmux detector viability verdict and resolve plan Open question 1" (deferred, split-child, umbrella)
- tb-5n9: "Prototype tmux-level fallback detector to validate the harness-agnostic adapter seam" (deferred, umbrella)

**With `split-child` label only (6 beads):**
- tb-163k: "Analyze test results and document findings in decisions.md"
- tb-2ir: "Record tmux detector viability verdict in decisions.md"
- tb-2lh: "Run first test iteration and establish measurement baseline"
- tb-3iu: "Resolve Open question 1 in plan.md"
- tb-5wj: "Document production enablement or alternatives for tmux detector"
- tb-62m: "Execute remaining test iterations (runs 2-5)"

### Design Behavior

The `br claim` command (bead-forge) internally filters beads with these labels:
- **`deferred`** - Beads that should be worked on later
- **`split-child`** - Sub-tasks that should be claimed together with their parent umbrella bead
- **`umbrella`** - Parent beads that manage their own children

This is **working as designed**, not a configuration error.

### Database vs JSONL Sync

The investigation also revealed that `.beads/issues.jsonl` was stale - it showed tb-1me as `in_progress` when the database had it as `open`. A `br sync --flush-only` would fix this, but it doesn't affect the core issue.

## Resolution

**False alarm** - The starvation alert was triggered because the monitoring system saw open beads but didn't account for label-based filtering. The bead-worker system correctly identified that there are 0 beads available to claim after applying the intended filters.

## Recommendations

1. **Update starvation detection** - Future alerts should check `br claim --dry-run` output instead of just counting open beads
2. **Label documentation** - Ensure the bead-worker documentation clearly explains which labels cause beads to be filtered
3. **Monitoring improvement** - The alert should distinguish between:
   - **Actual starvation** (beads exist but can't be claimed due to a bug)
   - **Expected filtering** (all open beads have special labels and shouldn't be claimed)
