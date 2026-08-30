// Trail Boss daemon: ingest endpoint, state, queue, reconcile loop
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { HookEvent, NormalizedEvent } from "./types.ts";
import { adaptHookEvent, isStuckEvent, isUnstuckEvent, isSessionRegistered, isSessionEnded } from "./claude-adapter.ts";
import { upsertSession, deleteSession, enqueue, dequeue, dequeueByPaneId, skipHead, getHead, getStuckCount, getAllStuck, cleanupQueue, getSession } from "./db.ts";
import { startReconcileLoop, reconcileStuckDirection } from "./reconcile.ts";
import { startNotificationChecker } from "./notify.ts";
import { execSync } from "child_process";

const PORT = parseInt(process.env.TRAILBOSS_PORT || "4000", 10);
const HOST = "127.0.0.1"; // Loopback only
const SKIP_COOLDOWN_MS = 30_000; // 30 seconds
const AUTO_JUMP_ENABLED = process.env.TRAILBOSS_AUTO_JUMP === "1";
const SPOOL_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../.trailboss-spool.jsonl");
const DATA_DIR = process.env.TRAILBOSS_DATA_DIR ?? path.join(process.env.HOME ?? "", ".local/share/trailboss");
const FAILED_EVENTS_FILE = path.join(DATA_DIR, "failed-events.jsonl");

// Ensure data directory exists
fs.mkdirSync(DATA_DIR, { recursive: true });

// Replay spooled events from client-side failures during daemon restart
function replaySpool(): { replayed: number; failed: number } {
  if (!fs.existsSync(SPOOL_FILE)) {
    return { replayed: 0, failed: 0 };
  }

  const content = fs.readFileSync(SPOOL_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(line => line.length > 0);

  if (lines.length === 0) {
    fs.unlinkSync(SPOOL_FILE);
    return { replayed: 0, failed: 0 };
  }

  let replayed = 0;
  let failed = 0;
  const failedEntries: Array<{ timestamp: string; paneId: string; payload: string; error: string }> = [];

  for (const line of lines) {
    // Spool format: "TIMESTAMP PANE_ID JSON_PAYLOAD"
    // Extract the first two fields and treat the rest as JSON
    const spaceIndex1 = line.indexOf(" ");
    const spaceIndex2 = line.indexOf(" ", spaceIndex1 + 1);

    if (spaceIndex1 === -1 || spaceIndex2 === -1) {
      const error = `malformed line (missing timestamp/pane_id delimiter)`;
      console.error(`[spool] ${error}, skipping: ${line.slice(0, 50)}...`);
      failedEntries.push({ timestamp: new Date().toISOString(), paneId: "unknown", payload: line, error });
      failed++;
      continue;
    }

    const timestamp = line.slice(0, spaceIndex1);
    const paneId = line.slice(spaceIndex1 + 1, spaceIndex2);
    const payload = line.slice(spaceIndex2 + 1);

    try {
      const raw: HookEvent = JSON.parse(payload);
      const event = adaptHookEvent(raw, paneId);

      // Process the event exactly as if it were a fresh POST
      if (isStuckEvent(event)) {
        if (event.sessionId !== event.paneId) {
          dequeueByPaneId(event.paneId, event.sessionId);
        }
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          event.timestamp,
          event.reason,
          event.message
        );
        enqueue(event.sessionId, event.reason, event.timestamp);
        console.log(`[spool] stuck: ${event.sessionId.slice(0, 8)} (${event.reason})`);
      } else if (isUnstuckEvent(event)) {
        dequeue(event.sessionId);
        dequeueByPaneId(event.paneId, event.sessionId);
        console.log(`[spool] unstuck: ${event.sessionId.slice(0, 8)}`);
      } else if (isSessionRegistered(event)) {
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          null,
          null,
          null
        );
        console.log(`[spool] registered: ${event.sessionId.slice(0, 8)} -> ${event.paneId}`);
      } else if (isSessionEnded(event)) {
        deleteSession(event.sessionId);
        console.log(`[spool] ended: ${event.sessionId.slice(0, 8)}`);
      }

      replayed++;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[spool] failed to replay event: ${error}`);
      failedEntries.push({ timestamp, paneId, payload, error });
      failed++;
    }
  }

  // Log failed events to persistent file for forensics
  if (failedEntries.length > 0) {
    try {
      const failedLog = failedEntries.map(entry =>
        JSON.stringify({ timestamp: entry.timestamp, pane_id: entry.paneId, error: entry.error, payload: entry.payload })
      ).join("\n") + "\n";
      fs.appendFileSync(FAILED_EVENTS_FILE, failedLog);
      console.log(`[spool] logged ${failedEntries.length} failed events to ${FAILED_EVENTS_FILE}`);
    } catch (err) {
      console.error(`[spool] failed to write to ${FAILED_EVENTS_FILE}: ${err}`);
    }
  }

  // Remove spool file after replay attempt (whether successful or not)
  try {
    fs.unlinkSync(SPOOL_FILE);
  } catch {
    // Ignore errors removing the spool file
  }

  return { replayed, failed };
}

// Run stuck-direction reconcile on startup to recover sessions that became stuck while daemon was down
console.log("[startup] running stuck-direction reconcile...");
const stuckResult = reconcileStuckDirection();
if (stuckResult.enqueued > 0) {
  console.log(`[startup] enqueued ${stuckResult.enqueued}/${stuckResult.checked} sessions from transcripts`);
} else {
  console.log(`[startup] no stuck sessions recovered from transcripts (${stuckResult.checked} checked)`);
}

// Replay any spooled events from client-side hook failures during restart
console.log("[startup] replaying spooled events...");
const spoolResult = replaySpool();
if (spoolResult.replayed > 0) {
  console.log(`[startup] replayed ${spoolResult.replayed} spooled events (${spoolResult.failed} failed)`);
} else {
  console.log(`[startup] no spooled events to replay`);
}

// Start reconcile loop (runs every 5s by default)
startReconcileLoop(5000);

// Cleanup old queue entries hourly
setInterval(() => cleanupQueue(), 60 * 60 * 1000);

// Start notification checker (sends alerts when queue depth crosses threshold)
startNotificationChecker();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  try {
    // POST /event - hook ingest endpoint
    if (req.method === "POST" && url.pathname === "/event") {
      const paneId = req.headers["x-tmux-pane"] as string | undefined;
      if (!paneId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing X-Tmux-Pane header" }));
        return;
      }

      const body: string = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      let raw: HookEvent;
      try {
        raw = JSON.parse(body) as HookEvent;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const event = adaptHookEvent(raw, paneId);

      if (isStuckEvent(event)) {
        // Clean up any bootstrap synthetic entry for this pane before registering real session
        if (event.sessionId !== event.paneId) {
          dequeueByPaneId(event.paneId, event.sessionId);
        }
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          event.timestamp,
          event.reason,
          event.message
        );
        enqueue(event.sessionId, event.reason, event.timestamp);
        console.log(`[event] stuck: ${event.sessionId.slice(0, 8)} (${event.reason})`);
      } else if (isUnstuckEvent(event)) {
        // Dequeue by session_id; also clean up any bootstrap entry for this pane
        const sess = getSession(event.sessionId);
        dequeue(event.sessionId);
        dequeueByPaneId(event.paneId, event.sessionId);
        console.log(`[event] unstuck: ${event.sessionId.slice(0, 8)}`);
        // Auto-jump if enabled and this was the operator's current pane
        if (sess) {
          maybeAutoJump(sess.pane_id);
        }
      } else if (isSessionRegistered(event)) {
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          null,
          null,
          null
        );
        console.log(`[event] registered: ${event.sessionId.slice(0, 8)} -> ${event.paneId}`);
      } else if (isSessionEnded(event)) {
        deleteSession(event.sessionId);
        console.log(`[event] ended: ${event.sessionId.slice(0, 8)}`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /event/normalized - normalized event ingest endpoint
    //
    // This endpoint accepts pre-normalized stuck/unstuck/registered/ended events
    // directly from harness-agnostic adapters (tmux detector, future hooks).
    //
    // Design decision: We chose a separate /event/normalized endpoint over wrapping
    // tmux events in the Claude hook format because:
    // 1. Keeps the adapter layer clean — adapters emit normalized events directly
    // 2. Avoids coupling non-Claude sources to Claude-specific data structures
    // 3. The normalized contract is already the internal model — we expose it directly
    //
    // See docs/notes/decisions.md for full rationale.
    if (req.method === "POST" && url.pathname === "/event/normalized") {
      const body: string = await new Promise((resolve) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
      });

      let event: NormalizedEvent;
      try {
        event = JSON.parse(body) as NormalizedEvent;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      // Validate type discriminator
      if (!event.type || !["stuck", "unstuck", "registered", "ended"].includes(event.type)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing or invalid event type" }));
        return;
      }

      // Route by event type
      if (event.type === "stuck") {
        // Clean up any bootstrap synthetic entry for this pane before registering real session
        if (event.sessionId !== event.paneId) {
          dequeueByPaneId(event.paneId, event.sessionId);
        }
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          event.timestamp,
          event.reason,
          event.message
        );
        enqueue(event.sessionId, event.reason, event.timestamp);
        console.log(`[normalized] stuck: ${event.sessionId.slice(0, 8)} (${event.reason})`);
      } else if (event.type === "unstuck") {
        const sess = getSession(event.sessionId);
        dequeue(event.sessionId);
        console.log(`[normalized] unstuck: ${event.sessionId.slice(0, 8)}`);
        // Auto-jump if enabled and this was the operator's current pane
        if (sess) {
          maybeAutoJump(sess.pane_id);
        }
      } else if (event.type === "registered") {
        upsertSession(
          event.sessionId,
          event.paneId,
          event.cwd,
          event.transcriptPath,
          null,
          null,
          null
        );
        console.log(`[normalized] registered: ${event.sessionId.slice(0, 8)} -> ${event.paneId}`);
      } else if (event.type === "ended") {
        deleteSession(event.sessionId);
        console.log(`[normalized] ended: ${event.sessionId.slice(0, 8)}`);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /next - return the head-of-queue pane id
    if (req.method === "GET" && url.pathname === "/next") {
      const head = getHead();
      if (!head) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paneId: null, reason: "queue empty" }));
        return;
      }

      const sess = await getStoredSession(head.session_id);
      if (!sess) {
        // Shouldn't happen due to FK, but handle gracefully
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paneId: null, reason: "session not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ paneId: sess.pane_id, sessionId: sess.session_id, reason: null }));
      return;
    }

    // POST /skip - skip current head and move to tail
    if (req.method === "POST" && url.pathname === "/skip") {
      const head = getHead();
      if (!head) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paneId: null, reason: "queue empty" }));
        return;
      }

      skipHead(head.session_id, SKIP_COOLDOWN_MS);
      console.log(`[skip] ${head.session_id.slice(0, 8)} moved to tail (cooldown ${SKIP_COOLDOWN_MS}ms)`);

      // Return the new head
      const newHead = getHead();
      if (!newHead) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paneId: null, reason: "queue empty after skip" }));
        return;
      }

      const sess = await getStoredSession(newHead.session_id);
      if (!sess) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ paneId: null, reason: "session not found" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ paneId: sess.pane_id, sessionId: sess.session_id, reason: null }));
      return;
    }

    // GET /queue - list all stuck items (for popup display)
    if (req.method === "GET" && url.pathname === "/queue") {
      const items = getAllStuck(50);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ items, count: items.length }));
      return;
    }

    // GET /status - simple health/status endpoint
    if (req.method === "GET" && url.pathname === "/status") {
      const stuckCount = getStuckCount();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", stuckCount }));
      return;
    }

    // 404
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[request] error:", err);
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Internal server error" }));
  }
});

async function getStoredSession(sessionId: string): Promise<{ session_id: string; pane_id: string } | null> {
  // Direct query since db.ts functions return full rows
  const { db } = await import("./db.ts");
  const stmt = db.prepare("SELECT session_id, pane_id FROM sessions WHERE session_id = ?");
  return stmt.get(sessionId) as ReturnType<typeof getStoredSession>;
}

// Auto-jump on resolve: if the operator's current pane just resolved and there's a next item, jump to it
function maybeAutoJump(resolvedPaneId: string): void {
  if (!AUTO_JUMP_ENABLED) {
    return;
  }

  try {
    // Get the operator's current attached pane
    const currentPane = execSync("tmux display -p '#{pane_id}'", { encoding: "utf-8" }).trim();

    // Only auto-jump if the operator was attached to the pane that just resolved
    if (currentPane !== resolvedPaneId) {
      return;
    }

    // Check if there's a next item in the queue
    const head = getHead();
    if (!head) {
      return; // Queue is empty, nothing to jump to
    }

    const sess = getSession(head.session_id);
    if (!sess) {
      return; // Session not found, shouldn't happen due to FK
    }

    // Perform the jump: switch-client, select-window, select-pane
    const sessionName = execSync(`tmux display -p -t '${sess.pane_id}' '#{session_name}'`, { encoding: "utf-8" }).trim();
    if (!sessionName) {
      console.log(`[auto-jump] pane ${sess.pane_id} not found`);
      return;
    }

    execSync(`tmux switch-client -t '${sessionName}' \\; select-window -t '${sess.pane_id}' \\; select-pane -t '${sess.pane_id}'`, { encoding: "utf-8" });
    console.log(`[auto-jump] ${resolvedPaneId} resolved → ${sess.pane_id}`);
  } catch (err) {
    // Don't crash the daemon on tmux errors (e.g., no server, detached client)
    console.error("[auto-jump] failed:", err);
  }
}

server.listen(PORT, HOST, () => {
  console.log(`[trailboss] daemon listening on http://${HOST}:${PORT}`);
});
