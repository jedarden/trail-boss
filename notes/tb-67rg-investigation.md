# Investigation: Starvation Alert tb-67rg

## Alert Summary
**Date:** 2026-07-02
**Alert:** "Beads invisible to worker" - 8 open beads but `br claim` returned `{}`

## Root Cause: NOT a Bug - Legitimate Blocking Chain

### Analysis
The 8 "invisible" open beads were correctly filtered by `br claim` due to having **unclosed blockers**. This is the expected behavior per the claim SQL query in `bead-forge/src/claim.rs` (lines 317-322):

```sql
AND NOT EXISTS (
    SELECT 1 FROM dependencies blocker_dep
    INNER JOIN issues blocker ON blocker.id = blocker_dep.depends_on_id
    WHERE blocker_dep.issue_id = i.id
    AND blocker_dep.type IN ('blocks', 'parent-child', 'conditional-blocks', 'waits-for')
    AND blocker.status != 'closed'
)
```

### The Blocking Chain
```
tb-1me (in_progress, updated 12min ago)
  ├─→ tb-163k (open, blocked by tb-1me)
  ├─→ tb-2ir   (open, blocked by tb-1me)
  ├─→ tb-2lh   (open, blocked by tb-1me)
  ├─→ tb-62m   (open, blocked by tb-1me)
  └─→ tb-2ir → tb-3iu → tb-5wj → tb-23i → tb-5n9
       (chain of 5 more blocked beads)
```

**Root blocker:** `tb-1me` - "Run tmux detector acceptance tests and gather metrics"
- Status: `in_progress`
- Assignee: `claude-code-glm47-juliet`
- Last updated: 2026-07-02 18:59:36 UTC (~12 minutes ago)
- Claim TTL: 30 minutes (not stale yet)

### All Open Beads Have Blockers

| Bead ID | Title | Blocked By |
|---------|-------|------------|
| tb-163k | Analyze test results... | tb-1me |
| tb-2ir | Record tmux detector viability... | tb-1me |
| tb-2lh | Run first test iteration... | tb-1me |
| tb-62m | Execute remaining test iterations... | tb-1me |
| tb-3iu | Resolve Open question 1... | tb-2ir |
| tb-5wj | Document production enablement... | tb-3iu |
| tb-23i | Record tmux detector viability... | tb-5wj |
| tb-5n9 | Prototype tmux-level fallback detector... | tb-23i |

### Labels on Blocked Beads
All blocked beads carry the `split-child` label, which indicates they were created from a parent/umbrella bead. This label does NOT affect claim eligibility - the blocker filter is what matters.

## Conclusion

**Status:** FALSE POSITIVE - No configuration error
**Cause:** Legitimate dependency blocking, not a bug
**Resolution:** Document the blocking chain behavior; update starvation detection to account for blocked beads

## Recommendations

1. **For Pluck/starvation detection:** When reporting "X open beads but none claimed," also check how many have unclosed blockers
2. **For workflow:** The blocking chain is valid - wait for `tb-1me` to complete, then the chain will unblock sequentially
3. **Documentation:** Add notes explaining that `split-child` beads with dependencies are filtered from claim queries
