// Trail Boss daemon: ingest endpoint, state, queue, reconcile loop
import * as http from "http";
import type { HookEvent } from "./types.ts";
import { adaptHookEvent, isStuckEvent, isUnstuckEvent, isSessionRegistered, isSessionEnded } from "./claude-adapter.ts";
import { upsertSession, deleteSession, enqueue, dequeue, skipHead, getHead, getStuckCount, getAllStuck, cleanupQueue } from "./db.ts";
import { startReconcileLoop } from "./reconcile.ts";

const PORT = 4000;
const HOST = "127.0.0.1"; // Loopback only
const SKIP_COOLDOWN_MS = 30_000; // 30 seconds

// Start reconcile loop (runs every 5s by default)
startReconcileLoop(5000);

// Cleanup old queue entries hourly
setInterval(() => cleanupQueue(), 60 * 60 * 1000);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "", `http://${req.headers.host}`);

  // CORS for local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tmux-Pane");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

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
        // Upsert session with stuck info, then enqueue
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
        dequeue(event.sessionId);
        console.log(`[event] unstuck: ${event.sessionId.slice(0, 8)}`);
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

server.listen(PORT, HOST, () => {
  console.log(`[trailboss] daemon listening on http://${HOST}:${PORT}`);
});
