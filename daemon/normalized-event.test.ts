import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const repoRoot = join(import.meta.dir, "..");
const port = 4300 + Math.floor(Math.random() * 500);
const baseUrl = `http://127.0.0.1:${port}`;

let dataDir: string;
let daemon: ChildProcess;

async function waitForDaemon(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/status`);
      if (response.ok) {
        return;
      }
    } catch {
      // The daemon may still be starting.
    }
    await Bun.sleep(100);
  }
  throw new Error("normalized-event test daemon did not start");
}

async function postNormalized(body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/event/normalized`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}

async function postEvent(event: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  return postNormalized(JSON.stringify(event));
}

beforeAll(async () => {
  dataDir = await mkdtemp("/tmp/trailboss-normalized-event-");
  daemon = spawn(process.execPath, ["run", "daemon/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TRAILBOSS_PORT: String(port),
      TRAILBOSS_DATA_DIR: dataDir,
    },
    stdio: "ignore",
  });
  await waitForDaemon();
});

afterAll(async () => {
  daemon.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    if (daemon.exitCode !== null) {
      resolve();
      return;
    }
    daemon.once("exit", () => resolve());
    setTimeout(resolve, 1000);
  });
  await rm(dataDir, { recursive: true, force: true });
});

describe("POST /event/normalized", () => {
  test("rejects malformed JSON and missing or unknown types", async () => {
    const malformedResponses = await Promise.all([
      postNormalized("{"),
      postNormalized("{"),
      postNormalized("not-json"),
    ]);
    expect(malformedResponses).toEqual([
      { status: 400, json: { error: "Invalid JSON" } },
      { status: 400, json: { error: "Invalid JSON" } },
      { status: 400, json: { error: "Invalid JSON" } },
    ]);
    const invalidTypeResponses = await Promise.all([
      postNormalized("null"),
      postNormalized("[]"),
      postEvent({ sessionId: "missing-type" }),
      postEvent({ type: "" }),
      postEvent({ type: 42 }),
      postEvent({ type: null }),
    ]);
    expect(invalidTypeResponses).toEqual(invalidTypeResponses.map(() => ({
      status: 400,
      json: { error: "Invalid or missing event type" },
    })));
    await expect(postEvent({ type: "paused" })).resolves.toEqual({
      status: 400,
      json: { error: "Unknown event type" },
    });
  });

  test("rejects missing required fields and invalid values for every event type", async () => {
    const timestamp = Date.now();
    const validEvents: Record<string, Record<string, unknown>> = {
      stuck: {
        type: "stuck",
        sessionId: "invalid-fields",
        paneId: "%invalid",
        cwd: "/tmp",
        transcriptPath: "",
        reason: "stopped",
        message: "blocked",
        timestamp,
      },
      unstuck: { type: "unstuck", sessionId: "invalid-fields", timestamp },
      registered: {
        type: "registered",
        sessionId: "invalid-fields",
        paneId: "%invalid",
        cwd: "/tmp",
        transcriptPath: "",
        timestamp,
      },
      ended: { type: "ended", sessionId: "invalid-fields", timestamp },
    };
    const requiredFields: Record<string, string[]> = {
      stuck: ["sessionId", "paneId", "cwd", "transcriptPath", "reason", "message", "timestamp"],
      unstuck: ["sessionId", "timestamp"],
      registered: ["sessionId", "paneId", "cwd", "transcriptPath", "timestamp"],
      ended: ["sessionId", "timestamp"],
    };
    const missingFieldEvents = Object.entries(requiredFields).flatMap(([type, fields]) =>
      fields.map((field) => {
        const event = { ...validEvents[type] };
        delete event[field];
        return event;
      })
    );
    const invalidValueEvents = [
      { ...validEvents.stuck, sessionId: "  " },
      { ...validEvents.stuck, paneId: "" },
      { ...validEvents.stuck, cwd: 42 },
      { ...validEvents.stuck, transcriptPath: null },
      { ...validEvents.stuck, reason: "other" },
      { ...validEvents.stuck, message: "  " },
      { ...validEvents.stuck, timestamp: 0 },
      { ...validEvents.stuck, timestamp: "2024-01-01" },
      { ...validEvents.unstuck, sessionId: 42 },
      { ...validEvents.unstuck, timestamp: -1 },
      { ...validEvents.unstuck, timestamp: null },
      { ...validEvents.registered, sessionId: "" },
      { ...validEvents.registered, paneId: 42 },
      { ...validEvents.registered, cwd: false },
      { ...validEvents.registered, transcriptPath: [] },
      { ...validEvents.registered, timestamp: 0 },
      { ...validEvents.ended, sessionId: "\t" },
      { ...validEvents.ended, timestamp: "later" },
    ];

    for (const event of [...missingFieldEvents, ...invalidValueEvents]) {
      await expect(postEvent(event)).resolves.toEqual({
        status: 400,
        json: { error: "Invalid event fields" },
      });
    }
    await expect(postNormalized('{"type":"ended","sessionId":"overflow","timestamp":1e400}')).resolves.toEqual({
      status: 400,
      json: { error: "Invalid event fields" },
    });
  });

  test("does not dispatch an event with invalid fields", async () => {
    const sessionId = `invalid-dispatch-${crypto.randomUUID()}`;
    const invalidRegisteredId = `${sessionId}-registered`;
    const invalidStuckId = `${sessionId}-stuck`;
    const db = new Database(join(dataDir, "trailboss.db"));

    try {
      const registered = {
        type: "registered",
        sessionId,
        paneId: "%invalid-dispatch",
        cwd: "",
        transcriptPath: "",
        timestamp: Date.now(),
      };
      const stuck = {
        type: "stuck",
        sessionId,
        paneId: "%invalid-dispatch",
        cwd: repoRoot,
        transcriptPath: "",
        reason: "stopped",
        message: "waiting for input",
        timestamp: Date.now(),
      };
      await expect(postEvent(registered)).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postEvent(stuck)).resolves.toEqual({ status: 200, json: { ok: true } });

      const invalidEvents = [
        { ...registered, sessionId: invalidRegisteredId, paneId: "" },
        { ...stuck, sessionId: invalidStuckId, reason: "unknown" },
        { type: "unstuck", sessionId, timestamp: 0 },
        { type: "ended", sessionId, timestamp: 0 },
      ];
      for (const event of invalidEvents) {
        await expect(postEvent(event)).resolves.toEqual({
          status: 400,
          json: { error: "Invalid event fields" },
        });
      }
      await expect(postEvent({ type: "paused", sessionId, timestamp: Date.now() })).resolves.toEqual({
        status: 400,
        json: { error: "Unknown event type" },
      });

      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(invalidRegisteredId)).toBeNull();
      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(invalidStuckId)).toBeNull();
      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).not.toBeNull();
      expect(
        db.query("SELECT COUNT(*) AS count FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId)
      ).toEqual({ count: 1 });
    } finally {
      db.query("DELETE FROM queue WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      db.close();
    }
  });

  test("dispatches all event types and keeps duplicate events idempotent", async () => {
    const sessionId = "normalized-lifecycle";
    const db = new Database(join(dataDir, "trailboss.db"));
    const registered = {
      type: "registered",
      sessionId,
      paneId: "%normalized",
      cwd: repoRoot,
      transcriptPath: "",
      timestamp: Date.now(),
    };
    const stuck = {
      type: "stuck",
      sessionId,
      paneId: "%normalized",
      cwd: repoRoot,
      transcriptPath: "",
      reason: "stopped",
      message: "waiting for input",
      timestamp: Date.now(),
    };
    const unstuck = { type: "unstuck", sessionId, timestamp: Date.now() };
    const ended = { type: "ended", sessionId, timestamp: Date.now() };

    for (const event of [registered, registered]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect(db.query("SELECT pane_id, cwd, transcript_path, last_stuck_at FROM sessions WHERE session_id = ?").get(sessionId)).toEqual({
      pane_id: registered.paneId,
      cwd: registered.cwd,
      transcript_path: registered.transcriptPath,
      last_stuck_at: null,
    });
    expect(db.query("SELECT COUNT(*) AS count FROM queue WHERE session_id = ?").get(sessionId)).toEqual({ count: 0 });

    for (const event of [stuck, stuck]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect(db.query("SELECT last_stuck_at, last_stuck_reason, last_message FROM sessions WHERE session_id = ?").get(sessionId)).toEqual({
      last_stuck_at: stuck.timestamp,
      last_stuck_reason: stuck.reason,
      last_message: stuck.message,
    });
    expect(db.query("SELECT stuck_at, reason, dequeued_at FROM queue WHERE session_id = ?").all(sessionId)).toEqual([
      { stuck_at: stuck.timestamp, reason: stuck.reason, dequeued_at: null },
    ]);
    expect((await (await fetch(`${baseUrl}/status`)).json()).stuckCount).toBe(1);

    for (const event of [unstuck, unstuck]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toEqual({ session_id: sessionId });
    expect(db.query("SELECT dequeued_at FROM queue WHERE session_id = ?").all(sessionId)).toEqual([
      { dequeued_at: expect.any(Number) },
    ]);
    expect((await (await fetch(`${baseUrl}/status`)).json()).stuckCount).toBe(0);

    for (const event of [ended, ended]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect((await (await fetch(`${baseUrl}/queue`)).json()).count).toBe(0);

    expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();
    expect(db.query("SELECT id FROM queue WHERE session_id = ?").all(sessionId)).toEqual([]);
    db.close();
  });

  test("stale duplicate stuck after unstuck is ignored without re-enqueueing, a newer stuck still applies", async () => {
    const sessionId = `stale-stuck-${crypto.randomUUID()}`;
    const paneId = `%${sessionId}`;
    const t0 = Date.now();
    const registered = {
      type: "registered", sessionId, paneId, cwd: repoRoot, transcriptPath: "", timestamp: t0,
    };
    const stuck = (ts: number) => ({
      type: "stuck", sessionId, paneId, cwd: repoRoot, transcriptPath: "",
      reason: "stopped", message: "waiting for input", timestamp: ts,
    });
    const db = new Database(join(dataDir, "trailboss.db"));
    const liveQueueRows = () =>
      db.query("SELECT COUNT(*) AS count FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId) as { count: number };

    try {
      await expect(postEvent(registered)).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postEvent(stuck(t0 + 1000))).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(1);

      // Session progresses past the stuck event...
      await expect(postEvent({ type: "unstuck", sessionId, timestamp: t0 + 2000 })).resolves.toEqual({
        status: 200, json: { ok: true },
      });
      expect(
        db.query("SELECT last_unstuck_at FROM sessions WHERE session_id = ?").get(sessionId)
      ).toEqual({ last_unstuck_at: t0 + 2000 });
      expect(liveQueueRows().count).toBe(0);

      // ...so the retried stuck event (same producer timestamp) is a no-op that
      // still returns the documented success response.
      await expect(postEvent(stuck(t0 + 1000))).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(0);
      expect(
        db.query("SELECT last_stuck_at, last_stuck_reason, last_message FROM sessions WHERE session_id = ?").get(sessionId)
      ).toEqual({ last_stuck_at: t0 + 1000, last_stuck_reason: "stopped", last_message: "waiting for input" });

      // A genuinely newer stuck event is not suppressed.
      await expect(postEvent(stuck(t0 + 3000))).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(1);
      expect(
        db.query("SELECT stuck_at FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId)
      ).toEqual({ stuck_at: t0 + 3000 });
    } finally {
      await postEvent({ type: "ended", sessionId, timestamp: t0 + 4000 });
      db.close();
    }
  });

  test("duplicate stuck, registered, and ended events after ended do not resurrect state", async () => {
    const sessionId = `ended-retry-${crypto.randomUUID()}`;
    const paneId = `%${sessionId}`;
    const t0 = Date.now();
    const registered = {
      type: "registered", sessionId, paneId, cwd: repoRoot, transcriptPath: "", timestamp: t0,
    };
    const stuck = {
      type: "stuck", sessionId, paneId, cwd: repoRoot, transcriptPath: "",
      reason: "permission", message: "[Bash] rm -rf /tmp/x", timestamp: t0 + 1000,
    };
    const endedTs = t0 + 2000;
    const db = new Database(join(dataDir, "trailboss.db"));

    try {
      await expect(postEvent(registered)).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postEvent(stuck)).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postEvent({ type: "ended", sessionId, timestamp: endedTs })).resolves.toEqual({
        status: 200, json: { ok: true },
      });
      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();

      // Every retried event that predates the end is accepted with the
      // documented success body but resurrects nothing.
      const retries = [
        { label: "stuck", event: stuck },
        { label: "registered", event: registered },
        { label: "ended", event: { type: "ended", sessionId, timestamp: endedTs } },
        { label: "unstuck", event: { type: "unstuck", sessionId, timestamp: t0 + 1500 } },
      ] as const;
      for (const { label, event } of retries) {
        await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
        expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();
        expect(db.query("SELECT id FROM queue WHERE session_id = ?").all(sessionId)).toEqual([]);
        expect(db.query("SELECT COUNT(*) AS count FROM ended_sessions WHERE session_id = ?").get(sessionId))
          .toEqual({ count: 1 });
        console.log(`[test] retried ${label} after ended left no state`);
      }

      // Boundary: a registration newer than the tombstone is a fresh event,
      // not a retry, and is accepted.
      await expect(postEvent({ ...registered, timestamp: endedTs + 1000 })).resolves.toEqual({
        status: 200, json: { ok: true },
      });
      expect(db.query("SELECT pane_id FROM sessions WHERE session_id = ?").get(sessionId)).toEqual({ pane_id: paneId });
    } finally {
      db.query("DELETE FROM queue WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      db.close();
      await postEvent({ type: "ended", sessionId, timestamp: endedTs + 2000 });
    }
  });

  test("hook-path duplicate events stay idempotent against the persistence layer", async () => {
    const sessionId = `hook-idempotent-${crypto.randomUUID()}`;
    const paneId = `%${sessionId}`;
    const postHook = async (hookEventName: string, extra: Record<string, unknown> = {}) => {
      const response = await fetch(`${baseUrl}/event`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-tmux-pane": paneId },
        body: JSON.stringify({
          session_id: sessionId, transcript_path: "", cwd: repoRoot,
          hook_event_name: hookEventName, ...extra,
        }),
      });
      return { status: response.status, json: await response.json() as Record<string, unknown> };
    };
    const db = new Database(join(dataDir, "trailboss.db"));
    const liveQueueRows = () =>
      db.query("SELECT COUNT(*) AS count FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId) as { count: number };

    try {
      // Duplicate Stop (stuck) hooks: one queue entry, one success response each.
      const stop = { last_assistant_message: "waiting for input" };
      await expect(postHook("Stop", stop)).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postHook("Stop", stop)).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(1);

      // Resolved via UserPromptSubmit, then a duplicate: both succeed, queue stays empty.
      await expect(postHook("UserPromptSubmit")).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(0);
      await expect(postHook("UserPromptSubmit")).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(liveQueueRows().count).toBe(0);

      // Duplicate SessionEnd hooks: the second is a no-op with the same success body.
      await expect(postHook("SessionStart")).resolves.toEqual({ status: 200, json: { ok: true } });
      await expect(postHook("SessionEnd")).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();
      await expect(postHook("SessionEnd")).resolves.toEqual({ status: 200, json: { ok: true } });
      expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();
      expect(db.query("SELECT id FROM queue WHERE session_id = ?").all(sessionId)).toEqual([]);
    } finally {
      db.query("DELETE FROM queue WHERE session_id = ?").run(sessionId);
      db.query("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
      db.close();
    }
  });

  test("stuck replaces a queued synthetic pane without a foreign-key error", async () => {
    const paneId = `%bootstrap-${crypto.randomUUID()}`;
    const sessionId = `real-${crypto.randomUUID()}`;
    const timestamp = Date.now();
    const stuck = (id: string) => ({
      type: "stuck",
      sessionId: id,
      paneId,
      cwd: repoRoot,
      transcriptPath: "",
      reason: "stopped",
      message: "waiting for input",
      timestamp,
    });

    await expect(postEvent(stuck(paneId))).resolves.toEqual({ status: 200, json: { ok: true } });
    await expect(postEvent(stuck(sessionId))).resolves.toEqual({ status: 200, json: { ok: true } });

    const db = new Database(join(dataDir, "trailboss.db"));
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(paneId)).toBeNull();
    expect(db.query("SELECT id FROM queue WHERE session_id = ?").all(paneId)).toEqual([]);
    expect(db.query("SELECT reason FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId)).toEqual({ reason: "stopped" });
    db.close();
    await expect(postEvent({ type: "ended", sessionId, timestamp })).resolves.toEqual({ status: 200, json: { ok: true } });
  });

  test("unstuck clears a queued synthetic pane and retains the registered session", async () => {
    const paneId = `%bootstrap-${crypto.randomUUID()}`;
    const sessionId = `real-${crypto.randomUUID()}`;
    const timestamp = Date.now();
    await expect(postEvent({
      type: "stuck", sessionId: paneId, paneId, cwd: repoRoot, transcriptPath: "",
      reason: "stopped", message: "waiting for input", timestamp,
    })).resolves.toEqual({ status: 200, json: { ok: true } });
    await expect(postEvent({
      type: "registered", sessionId, paneId, cwd: repoRoot, transcriptPath: "", timestamp,
    })).resolves.toEqual({ status: 200, json: { ok: true } });
    await expect(postEvent({ type: "unstuck", sessionId, timestamp })).resolves.toEqual({
      status: 200, json: { ok: true },
    });

    const db = new Database(join(dataDir, "trailboss.db"));
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(paneId)).toBeNull();
    expect(db.query("SELECT id FROM queue WHERE session_id = ?").all(paneId)).toEqual([]);
    expect(db.query("SELECT pane_id FROM sessions WHERE session_id = ?").get(sessionId)).toEqual({ pane_id: paneId });
    expect((await (await fetch(`${baseUrl}/status`)).json()).stuckCount).toBe(0);
    db.close();
    await expect(postEvent({ type: "ended", sessionId, timestamp })).resolves.toEqual({ status: 200, json: { ok: true } });
  });
});
