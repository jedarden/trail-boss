# tb-5oiy: Starvation Alert Investigation

## Issue
The bead worker (Pluck) reported "No beads available to claim" even though the workspace had 5 open/in-progress beads.

## Root Cause
All open beads were **blocked by dependencies**:

```
tb-1sz9 (in_progress) ← blocks ← tb-69rc (open)
                                ↓
                             tb-4l7s (open)
                                ↓
                             tb-5n9 (open)
                                ↑
                             (also blocked by tb-23i)
```

### Dependency Chain
1. **tb-69rc** (open) - blocked by tb-1sz9 (in_progress)
2. **tb-4l7s** (open) - blocked by tb-69rc
3. **tb-5n9** (open) - blocked by tb-4l7s and tb-23i

### Additional Factor
- **tb-5n9** has the `deferred` label, which may also exclude it from claiming

## Why `br claim` Returns Nothing
The `br claim` command only returns beads that are:
- Status = `open`
- NOT blocked by any dependencies
- NOT ephemeral, pinned, or is_template
- NOT assigned to another worker

Since all open beads had blocking dependencies, none were "ready" to claim.

## Resolution
The starvation alert is **expected behavior** - the bead worker correctly identified that no beads were ready to be worked on. The dependency chain must be resolved (by completing tb-1sz9) before downstream beads become claimable.

## Lessons Learned
- Starvation alerts may indicate legitimate dependency blocking, not configuration errors
- Check `br ready` to see unblocked beads
- Use `sqlite3 .beads/beads.db "SELECT issue_id, depends_on_id FROM dependencies WHERE type='blocks'"` to audit blocking relationships
- Consider labeling blocked beads with `blocked` for visibility

## Verified Commands
```bash
# Check ready (unblocked) beads
br ready

# Check dependencies
sqlite3 .beads/beads.db "SELECT issue_id, depends_on_id FROM dependencies WHERE issue_id IN ('tb-5n9', 'tb-69rc', 'tb-4l7s');"

# Dry-run claim to see what would be claimed
br claim --assignee "test-worker" --dry-run
```
