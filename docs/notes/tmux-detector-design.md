# Tmux Detector Poller — Design Document

## Overview

The tmux detector is a **harness-agnostic fallback** for detecting stuck Claude Code sessions (or any coding harness) without relying on hook events. It watches opted-in tmux panes and emits stuck/unstuck events to the daemon's `/event/normalized` endpoint.

This design answers the key architectural questions and provides an implementable specification.

---

## Design Goals

1. **Harness-agnostic detection** — Works for any coding harness, not just Claude Code
2. **Opt-in model** — Panes explicitly opt-in; no surprise monitoring
3. **Low false-positive rate** — Avoid flagging active sessions as stuck
4. **Self-contained operation** — No harness hooks required
5. **Graceful degradation** — Handles panes that close, disappear, or change state

---

## Key Design Decisions

### 1. Opt-In Mechanism

**Decision: Pane-title prefix pattern**

Panes opt-in by including a specific prefix in their title. The detector polls all panes and filters for those with the matching prefix.

**Why not alternatives:**

| Alternative | Rejected Because |
|-------------|------------------|
| tmux user option (`@trailboss-monitor`) | Requires pane-specific configuration per session; not discoverable via `list-panes`; doesn't persist across pane reuse |
| Manual pane ID registration | Requires user to know pane IDs upfront; doesn't handle dynamic pane creation |
| Environment variable in pane | Not discoverable from outside the pane; requires harness cooperation |
| Session name pattern | Too coarse; affects all panes in a session |

**Chosen approach:**

- **Prefix:** `@tb-` (trail-boss)
- **Detection:** `tmux list-panes -a -F '#{pane_id} #{pane_title}' | grep '@tb-'`
- **Example pane title:** `@tb-alpha: implementing feature X`
- **User sets it via:** `tmux rename-window '@tb-alpha: working on task'` or shell that sets the title

**Advantages:**
- Visible to the user (they can see which panes are monitored)
- Discoverable via standard tmux commands
- Works across sessions and windows
- No per-pane configuration files
- Harness-agnostic (just a title string)

**Opt-out mechanism:** User removes the prefix from the title; detector automatically stops tracking.

---

### 2. Detecting "Quiet"

**Decision: `capture-pane` output hash comparison**

The detector captures the visible output of each opted-in pane on each poll cycle and computes a hash of the content. If the hash hasn't changed across polls and the quiet threshold has elapsed, the pane is considered "quiet."

**Why this approach:**

- **Reliable:** `tmux capture-pane -p -t <pane>` returns the exact visible content
- **No harness cooperation needed:** Works for any process running in the pane
- **Portable:** Standard tmux command, available on all systems
- **Deterministic:** Same content → same hash

**Hash algorithm (simplified for speed):**

```
hash = concat(
  first_line_length,
  last_line_length,
  first_10_chars_of_first_line,
  last_10_chars_of_last_line,
  total_line_count
)
```

This avoids storing full pane contents while detecting changes with high confidence. False positives are unlikely in practice (different content producing identical hash values).

**Poll interval:** 2 seconds (configurable)

- Tradeoff: Lower interval = faster detection but more CPU usage
- 2 seconds catches stuck sessions within a few seconds of occurrence
- tmux `capture-pane` is lightweight; overhead is acceptable

---

### 3. Prompt-Like Last Line Detection

**Decision: Regex pattern matching on last non-empty line**

Before declaring a pane "stuck," the detector checks whether the last line looks like a prompt. This reduces false positives (e.g., a long-running command with no output yet).

**Prompt patterns (configurable):**

```javascript
const PROMPT_PATTERNS = [
  /\$\s*$/,           // bash/zsh $
  />\s*$/,            // many shells >
  /#\s*$/,            // root #
  /\?\s*$/,           // confirmation prompts
  /\[.*?\]\s*$/,      // bracketed prompts like [y/N]
  /:\s*$/,            // colon prompts
  />>>\s*$/,          // Python REPL
  /\.\.\.\s*$/,       // Python continuation
  />\s*\>/,           // MySQL prompt
  /@/,                // Augie/other shells
];
```

**Algorithm:**

```
1. Capture pane output
2. Split by newlines
3. Find last non-empty line
4. Trim whitespace
5. Match against PROMPT_PATTERNS
6. If any pattern matches → "looks like prompt" → can be stuck
7. If no pattern matches → not stuck (might be mid-computation)
```

**False-positive mitigation:**

- A pane that's quiet but whose last line doesn't match any prompt pattern is **not** considered stuck
- Example: A long-running `make` with no output yet → last line might be the command itself, not a prompt → not stuck
- Once actual output appears, the prompt detection will re-evaluate on the next quiet period

**Extensibility:**

- Patterns are configurable via environment variable or config file
- Users can add harness-specific patterns (e.g., Augie's `@` prompt)
- Future enhancement: Learn prompts from pane history

---

### 4. Quiet Threshold

**Decision: 30 seconds (configurable)**

A pane must be quiet for 30 seconds before being considered "stuck."

**Why 30 seconds:**

- **Not too short:** Avoids flagging momentary pauses (e.g., agent thinking, network latency)
- **Not too long:** Catches stuck sessions within a reasonable time
- **Human scale:** 30 seconds is perceptible but not annoying
- **Empirical:** Claude Code turns often complete within seconds; 30s suggests a genuine block

**Tradeoffs:**

| Threshold | Pros | Cons |
|-----------|------|------|
| 10s | Faster detection | More false positives (thinking periods) |
| 30s (chosen) | Balanced | Slower to catch very short blocks |
| 60s | Fewer false positives | Slower detection; user may notice first |

**Configurability:**

- Environment variable: `TRAILBOSS_QUIET_THRESHOLD_MS` (default: 30000)
- CLI flag: `--quiet-threshold <ms>` (for detector script)
- Config file: `~/.config/trail-boss/config.toml` (future)

---

### 5. Unstuck Detection

**Decision: Any output change = unstuck**

When a pane is marked as stuck, the detector continues polling. On the next poll cycle:

1. Capture pane output
2. Compute hash
3. Compare to last-known hash
4. If hash changed → emit `unstuck` event → clear stuck state

**Why this is correct:**

- **Universal:** Any new output means the session is no longer blocked
- **Prompt-agnostic:** Works for any harness, any prompt style
- **Covers all cases:**
  - User typed input → new output → unstuck
  - Agent resumed (e.g., after auto-retry) → new output → unstuck
  - Command finished → new prompt → unstuck

**Edge cases handled:**

- **Pane closed:** Detected via `pane_exists()` check → emit `ended` event
- **Pane reused by new session:** Detected via title change (if title doesn't match `@tb-` prefix) → automatically untracked
- **Transient output (e.g., blinking cursor):** Hash comparison ignores whitespace-only changes

---

### 6. Session ID Generation

**Decision: Synthetic session ID from pane ID + timestamp**

For the tmux detector, there is no harness-provided session ID. The detector generates a **synthetic session ID** that uniquely identifies a pane monitoring session.

**Format:** `tmux-{paneId}-{startTimestamp}`

**Example:** `tmux-%446-1719987600000`

**Why this format:**

- **Pane ID:** Ties the synthetic session to a specific tmux pane (`%446`)
- **Start timestamp:** Makes the ID unique across restarts (same pane reused later = different ID)
- **Prefix `tmux-`:** Clearly indicates this is a synthetic session from the detector

**Stability:**

- The synthetic ID is generated when the detector first starts tracking a pane
- It persists until:
  - The pane is closed (`ended` event)
  - The pane title no longer matches `@tb-` (automatic untrack)
  - The detector restarts (new synthetic IDs for all panes)

**Bootstrap entries in daemon:**

When a pane is first detected as stuck, the daemon receives a `stuck` event with a synthetic `sessionId`. The daemon treats this as a **bootstrap entry** — a session that exists only for queue purposes, with no transcript or reconcile loop.

**Limitations:**

- **No transcript path:** Synthetic sessions have no `transcript.jsonl` to reconcile
- **No `cwd` auto-discovery:** Must use `pane_current_path` (tmux built-in)
- **No harness-specific context:** Can't distinguish `permission` vs `stopped` — always uses `reason: "stopped"`
- **Fragile across restarts:** Detector restart → new synthetic IDs → old entries orphaned (daemon will age them out)

These limitations are acceptable for a **fallback detector** — the primary Claude Code adapter (hooks) provides full fidelity.

---

## State Machine

Per-pane state machine:

```
                    ┌─────────────────┐
                    │   UNTRACKED     │  ← Pane doesn't exist or title lacks @tb- prefix
                    └────────┬────────┘
                             │ pane appears with @tb- title
                             ▼
                    ┌─────────────────┐
                    │   REGISTERED    │  ← Initial registration, emit 'registered' event
                    └────────┬────────┘
                             │
                             │ poll loop
                             ▼
                    ┌─────────────────┐
          ┌────────▶│   MONITORING    │ ◀─────┐  ← Normal polling state
          │         └────────┬────────┘      │
          │                  │               │
          │                  │ output        │ quiet for >30s
          │                  │ changed       │ AND last line looks
          │                  │               │ like prompt
          │                  │               │
          │    ┌─────────────┴───────────────┴────────────┐
          │    │                                       │
          │    │ (was stuck)                          │ (was not stuck)
          │    ▼                                       ▼
          │ ┌─────────┐                         ┌─────────────┐
          │ │ UNSTUCK │                         │    STUCK    │  ← Emit 'stuck' event
          │ └────┬────┘                         └──────┬──────┘
          │      │                                     │
          │      │ emit 'unstuck' event                │
          │      └─────────────┬───────────────────────┘
          │                    │
          └────────────────────┘
                                │
                                │ pane closed or title loses @tb-
                                ▼
                         ┌─────────────────┐
                         │  UNTRACKING     │  ← Emit 'ended' event
                         └─────────────────┘
```

**States:**

- **UNTRACKED:** Not monitoring (pane doesn't exist or title lacks prefix)
- **REGISTERED:** Initial registration (emits `registered` event, transitions to MONITORING)
- **MONITORING:** Normal polling (checking for output changes)
- **STUCK:** Quiet for >30s at a prompt (emitted `stuck` event, awaiting output change)
- **UNSTUCK:** Output changed after being stuck (emits `unstuck` event, returns to MONITORING)
- **UNTRACKING:** Pane closed or prefix removed (emits `ended` event, removes from tracking)

---

## Poll Loop Pseudocode

```javascript
// Configuration
const POLL_INTERVAL_MS = 2000;           // Check every 2 seconds
const QUIET_THRESHOLD_MS = 30000;         // 30 seconds of quiet = stuck
const OPT_IN_PREFIX = "@tb-";            // Pane title prefix for opt-in
const DAEMON_URL = "http://127.0.0.1:4000/event/normalized";

// State: tracked panes
trackedPanes = Map<paneId, PaneState>;

interface PaneState {
  paneId: string;
  sessionId: string;           // Synthetic: tmux-%446-1719987600000
  cwd: string;
  lastOutputHash: string;
  lastOutputTime: number;
  isStuck: boolean;
  firstSeenAt: number;
}

// Main poll loop
function pollLoop() {
  while (true) {
    sleep(POLL_INTERVAL_MS);

    // 1. Discover opted-in panes
    const optedInPanes = discoverOptedInPanes();

    // 2. Register new panes
    for (const paneId of optedInPanes) {
      if (!trackedPanes.has(paneId)) {
        registerPane(paneId);
      }
    }

    // 3. Untrack removed panes
    for (const paneId of trackedPanes.keys()) {
      if (!optedInPanes.has(paneId)) {
        untrackPane(paneId);
      }
    }

    // 4. Check each tracked pane
    for (const [paneId, state] of trackedPanes) {
      checkPane(paneId, state);
    }
  }
}

// Discover opted-in panes
function discoverOptedInPanes(): Set<string> {
  const result = new Set<string>();

  // List all panes with their titles
  const cmd = `tmux list-panes -a -F '#{pane_id} #{pane_title}'`;
  const lines = execSync(cmd).toString().trim().split('\n');

  for (const line of lines) {
    const [paneId, title] = line.split(' ', 2);
    if (title.startsWith(OPT_IN_PREFIX)) {
      result.add(paneId);
    }
  }

  return result;
}

// Register a new pane
function registerPane(paneId: string) {
  const cwd = getPaneCwd(paneId);
  const sessionId = `tmux-${paneId}-${Date.now()}`;
  const output = capturePane(paneId);
  const hash = hashOutput(output);

  trackedPanes.set(paneId, {
    paneId,
    sessionId,
    cwd,
    lastOutputHash: hash,
    lastOutputTime: Date.now(),
    isStuck: false,
    firstSeenAt: Date.now(),
  });

  // Emit registration event
  emitEvent({
    type: "registered",
    sessionId,
    paneId,
    cwd,
    transcriptPath: "", // No transcript for synthetic sessions
    timestamp: Date.now(),
  });

  log(`[detector] registered pane ${paneId} as ${sessionId}`);
}

// Untrack a pane (closed or removed prefix)
function untrackPane(paneId: string) {
  const state = trackedPanes.get(paneId);
  if (!state) return;

  emitEvent({
    type: "ended",
    sessionId: state.sessionId,
    timestamp: Date.now(),
  });

  trackedPanes.delete(paneId);
  log(`[detector] untracked pane ${paneId}`);
}

// Check a single pane for stuck state
function checkPane(paneId: string, state: PaneState) {
  const now = Date.now();

  // 1. Verify pane still exists
  if (!paneExists(paneId)) {
    untrackPane(paneId);
    return;
  }

  // 2. Capture output
  const output = capturePane(paneId);
  const hash = hashOutput(output);
  const outputChanged = (hash !== state.lastOutputHash);

  // 3. Handle output change
  if (outputChanged) {
    state.lastOutputHash = hash;
    state.lastOutputTime = now;

    // If was stuck, now unstuck
    if (state.isStuck) {
      state.isStuck = false;
      emitEvent({
        type: "unstuck",
        sessionId: state.sessionId,
        timestamp: now,
      });
      log(`[detector] unstuck: ${state.sessionId} (output changed)`);
    }

    return; // Not stuck, continue monitoring
  }

  // 4. Output hasn't changed — check quiet threshold
  const timeSinceOutput = now - state.lastOutputTime;
  const isQuiet = (timeSinceOutput >= QUIET_THRESHOLD_MS);

  if (isQuiet && !state.isStuck) {
    // Quiet threshold exceeded — check if looks like prompt
    if (looksLikePrompt(output)) {
      // Transition to stuck
      state.isStuck = true;
      emitEvent({
        type: "stuck",
        sessionId: state.sessionId,
        paneId: state.paneId,
        cwd: state.cwd,
        transcriptPath: "",
        reason: "stopped", // Tmux detector can't distinguish permission vs stopped
        message: getLastLine(output),
        timestamp: now,
      });
      log(`[detector] stuck: ${state.sessionId} (quiet for ${timeSinceOutput}ms)`);
    }
  }
}

// Capture pane output via tmux
function capturePane(paneId: string): string {
  const cmd = `tmux capture-pane -p -t ${paneId}`;
  return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

// Hash output for comparison (avoid storing full content)
function hashOutput(output: string): string {
  if (!output) return "";
  const lines = output.split('\n');
  const firstLine = lines[0] || "";
  const lastLine = lines[lines.length - 1] || "";
  return `${firstLine.length}-${lastLine.length}-${lines.length}-${firstLine.slice(0, 10)}-${lastLine.slice(-10)}`;
}

// Check if last line looks like a prompt
function looksLikePrompt(output: string): boolean {
  const lines = output.split('\n');
  const lastLine = lines[lines.length - 1].trim();

  for (const pattern of PROMPT_PATTERNS) {
    if (pattern.test(lastLine)) {
      return true;
    }
  }

  return false;
}

// Get last line for context
function getLastLine(output: string): string {
  const lines = output.split('\n');
  return lines[lines.length - 1].trim() || "[no output]";
}

// Get pane cwd via tmux
function getPaneCwd(paneId: string): string {
  try {
    const cmd = `tmux display -p -t ${paneId} '#{pane_current_path}'`;
    return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

// Emit event to daemon
async function emitEvent(event: NormalizedEvent): Promise<boolean> {
  try {
    const response = await fetch(DAEMON_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
    });
    return response.ok;
  } catch (err) {
    log(`[detector] emit error: ${err}`);
    return false;
  }
}

// Prompt patterns (configurable)
const PROMPT_PATTERNS = [
  /\$\s*$/,           // bash/zsh $
  />\s*$/,            // many shells >
  /#\s*$/,            // root #
  /\?\s*$/,           // confirmation prompts
  /\[.*?\]\s*$/,      // bracketed prompts like [y/N]
  /:\s*$/,            // colon prompts
  />>>\s*$/,          // Python REPL
  /\.\.\.\s*$/,       // Python continuation
  />\s*\>/,           // MySQL prompt
  /@/,                // Augie/other shells
];
```

---

## Error Handling & Edge Cases

### Pane closed during monitoring

**Detection:** `pane_exists()` returns `false` on poll cycle

**Action:** Emit `ended` event, remove from tracking

```javascript
if (!paneExists(paneId)) {
  untrackPane(paneId);
  return;
}
```

### Pane title loses `@tb-` prefix

**Detection:** Pane no longer appears in `discoverOptedInPanes()`

**Action:** Emit `ended` event, remove from tracking

### Pane reused by new session (same pane ID, different process)

**Detection:** Next poll cycle will see it still has `@tb-` prefix

**Action:** Continue tracking (synthetic session ID unchanged, but that's acceptable)

**Limitation:** If the new session is actually a different Claude Code session, the detector won't know. This is acceptable for a fallback detector.

### Daemon not running

**Detection:** `fetch(DAEMON_URL)` fails or returns non-200

**Action:** Log warning, continue polling (pane state tracked locally, events lost until daemon restarts)

```javascript
if (!response.ok) {
  log(`[detector] daemon error: ${response.status}`);
  // Continue polling — will retry on next cycle
  return false;
}
```

### tmux command fails

**Detection:** `execSync()` throws

**Action:** Return empty string / false, skip pane on this cycle

```javascript
try {
  return execSync(cmd).toString().trim();
} catch {
  return ""; // Graceful degradation
}
```

### High CPU usage from many panes

**Mitigation:**
- Poll interval is configurable (default 2s)
- Each `capture-pane` is lightweight (text buffer copy)
- For >20 panes, consider increasing poll interval

### Clock skew

**Not an issue:** All timestamps are from `Date.now()` (local system time)

---

## Integration with Daemon

The detector emits events to the daemon's `/event/normalized` endpoint using the contract defined in `normalized-event-contract.md`.

**Events emitted:**

1. **`registered`** — When a pane with `@tb-` prefix is first discovered
2. **`stuck`** — When a quiet pane at a prompt exceeds the quiet threshold
3. **`unstuck`** — When a stuck pane produces new output
4. **`ended`** — When a pane closes or loses the `@tb-` prefix

**Special considerations for synthetic sessions:**

- `transcriptPath` is always `""` (empty string) — synthetic sessions have no transcripts
- `reason` is always `"stopped"` — detector cannot distinguish `permission` vs `stopped`
- `sessionId` is synthetic (`tmux-%446-1719987600000`) — not a harness-provided ID
- `cwd` is from `pane_current_path` — tmux's best effort at the pane's working directory

**Daemon behavior:**

The daemon treats synthetic sessions identically to hook-based sessions for queue purposes:

- Stuck synthetic sessions appear in the queue
- Navigation works the same (pane ID is valid)
- `skip` and `next` work identically

**Reconcile loop behavior:**

Synthetic sessions have no `transcriptPath`, so the reconcile loop **cannot** verify their state by transcript tailing. They rely entirely on the detector's `unstuck` events for recovery.

**Limitation:** If the detector crashes and restarts, old synthetic sessions are orphaned in the daemon's queue. The daemon should age out entries with no recent updates (future enhancement: TTL-based expiration).

---

## Testing Strategy

### Unit tests

1. **`discoverOptedInPanes()`**
   - Mock `tmux list-panes` output
   - Assert correct parsing and filtering by `@tb-` prefix

2. **`hashOutput()`**
   - Test with identical output → same hash
   - Test with different output → different hash
   - Test edge cases (empty output, single line)

3. **`looksLikePrompt()`**
   - Test against known prompt patterns
   - Test non-prompts return `false`

4. **State transitions**
   - REGISTERED → MONITORING → STUCK → UNSTUCK → MONITORING
   - REGISTERED → MONITORING → UNTRACKING (pane closed)

### Integration tests

1. **End-to-end with test tmux server**
   - Create test tmux socket (`TMUX_TEST_SOCK`)
   - Spawn test panes with `@tb-` prefix
   - Run detector for N cycles
   - Assert events emitted to test daemon endpoint

2. **Daemon integration**
   - Run real daemon on test port
   - Run detector against it
   - Verify sessions appear in `/queue` endpoint

### Manual testing

1. **Create a stuck session:**
   ```bash
   # In a tmux pane
   tmux rename-window '@tb-test-pane'
   # Run a command that blocks on input
   read -p "Press Enter to continue..."
   ```

2. **Run the detector:**
   ```bash
   bun run daemon/tmux-detector.ts
   ```

3. **Verify:**
   - Pane registered (`registered` event)
   - After 30s, stuck (`stuck` event)
   - Press Enter in pane
   - Detector emits `unstuck` event
   - Remove `@tb-` from title
   - Detector emits `ended` event

---

## Future Enhancements (Out of Scope for v1)

1. **Auto-discovery of Claude Code sessions**
   - Detect `CLAUDE_CODE_SESSION_ID` env var in pane
   - Automatically add `@tb-` prefix to Claude Code panes
   - Eliminate manual opt-in for Claude Code

2. **Prompt pattern learning**
   - Analyze pane history to detect common prompts
   - Auto-add patterns to `PROMPT_PATTERNS`
   - Persist learned patterns to config file

3. **Adaptive quiet threshold**
   - Start with default (30s)
   - Adjust based on false-positive rate
   - Per-pane thresholds (some panes are naturally quieter)

4. **Transcript path inference**
   - Guess transcript path from pane contents or CWD
   - Enable reconcile loop for synthetic sessions
   - Improve recovery robustness

5. **TTL-based session expiration**
   - Daemon ages out synthetic sessions with no updates
   - Configurable TTL (default: 24 hours)
   - Prevents orphaned entries from detector restarts

---

## Summary

This design specifies a complete tmux detector poller that:

1. **Opts in via pane title prefix** (`@tb-`) — discoverable, visible, harness-agnostic
2. **Detects quiet via `capture-pane` hash comparison** — reliable, no harness hooks
3. **Validates prompts via regex patterns** — reduces false positives
4. **Uses a 30-second quiet threshold** — balanced between speed and accuracy
5. **Detects unstuck via output change** — universal signal
6. **Generates synthetic session IDs** — enables queue participation without harness IDs
7. **Emits to `/event/normalized`** — integrates cleanly with the daemon's adapter contract

The design is implementable, testable, and serves as a robust fallback for harness-agnostic stuck detection.
