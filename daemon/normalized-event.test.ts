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
    await expect(postNormalized("{")).resolves.toEqual({
      status: 400,
      json: { error: "Invalid JSON" },
    });
    await expect(postEvent({ sessionId: "missing-type" })).resolves.toEqual({
      status: 400,
      json: { error: "Invalid or missing event type" },
    });
    await expect(postEvent({ type: "paused" })).resolves.toEqual({
      status: 400,
      json: { error: "Unknown event type" },
    });
  });

  test("rejects invalid fields for each event shape", async () => {
    const common = { sessionId: "invalid-fields", timestamp: Date.now() };
    const invalidEvents = [
      { ...common, type: "unstuck", timestamp: 0 },
      { ...common, type: "ended", sessionId: "" },
      { ...common, type: "registered", paneId: 42, cwd: "/tmp", transcriptPath: "" },
      {
        ...common,
        type: "stuck",
        paneId: "%invalid",
        cwd: "/tmp",
        transcriptPath: "",
        reason: "other",
        message: "blocked",
      },
    ];

    for (const event of invalidEvents) {
      await expect(postEvent(event)).resolves.toEqual({
        status: 400,
        json: { error: "Invalid event fields" },
      });
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
