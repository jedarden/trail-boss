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

    for (const event of [registered, registered, stuck, stuck]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect((await (await fetch(`${baseUrl}/status`)).json()).stuckCount).toBe(1);

    for (const event of [unstuck, unstuck]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect((await (await fetch(`${baseUrl}/status`)).json()).stuckCount).toBe(0);

    for (const event of [ended, ended]) {
      await expect(postEvent(event)).resolves.toEqual({ status: 200, json: { ok: true } });
    }
    expect((await (await fetch(`${baseUrl}/queue`)).json()).count).toBe(0);

    const db = new Database(join(dataDir, "trailboss.db"));
    expect(db.query("SELECT session_id FROM sessions WHERE session_id = ?").get(sessionId)).toBeNull();
    db.close();
  });
});
