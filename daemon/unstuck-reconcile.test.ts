// UserPromptSubmit unstuck ⇄ transcript reconciliation interaction tests.
//
// These exercise the daemon state layer in-process against a throwaway data
// dir and an isolated tmux socket, so reconcileStuckDirection's real pane
// liveness check runs without touching the operator's tmux server.
//
// TRAILBOSS_DATA_DIR must be set before db.ts is imported (it resolves the
// database path at module load) — hence the dynamic imports below. This file
// is the only in-process importer of db.ts in the suite; if another test file
// ever imports it statically, whichever loads first wins the data dir.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execSync } from "node:child_process";

const dataDir = await mkdtemp("/tmp/trailboss-unstuck-reconcile-");
const savedDataDir = process.env.TRAILBOSS_DATA_DIR;
const savedTmuxSock = process.env.TMUX_TEST_SOCK;
process.env.TRAILBOSS_DATA_DIR = dataDir;

const tmuxSocket = join(dataDir, "tmux.sock");
process.env.TMUX_TEST_SOCK = tmuxSocket;

const { upsertSession, enqueue, dequeue, markSessionUnstuck, deleteSession, db } = await import("./db.ts");
const { detectStuckFromTranscriptTail, hasTranscriptAdvanced, reconcileStuckDirection } = await import("./reconcile.ts");

let paneId: string;

function startTmuxServer(): string {
  execSync(`tmux -S ${tmuxSocket} new-session -d -s unstuck-reconcile -x 80 -y 24`);
  return execSync(`tmux -S ${tmuxSocket} display -p -t unstuck-reconcile '#{pane_id}'`)
    .toString()
    .trim();
}

function killTmuxServer(): void {
  try {
    execSync(`tmux -S ${tmuxSocket} kill-server`);
  } catch {
    // Server may already be gone.
  }
}

async function writeTranscript(name: string, entries: Array<Record<string, unknown>>): Promise<string> {
  const transcriptPath = join(dataDir, name);
  await writeFile(
    transcriptPath,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n"
  );
  return transcriptPath;
}

const assistantAt = (ts: number, text = "waiting for input") => ({
  type: "assistant",
  timestamp: ts,
  message: { role: "assistant", content: text },
});
const userAt = (ts: number, text = "please continue") => ({
  type: "user",
  timestamp: ts,
  message: { role: "user", content: text },
});

function liveQueueCount(sessionId: string): number {
  return (
    db.query("SELECT COUNT(*) AS count FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId) as {
      count: number;
    }
  ).count;
}

beforeAll(() => {
  paneId = startTmuxServer();
});

afterAll(async () => {
  killTmuxServer();
  db.close();
  // Restore env so files running later in the same bun test process do not
  // inherit this file's throwaway data dir or (dead) tmux socket.
  if (savedDataDir === undefined) {
    delete process.env.TRAILBOSS_DATA_DIR;
  } else {
    process.env.TRAILBOSS_DATA_DIR = savedDataDir;
  }
  if (savedTmuxSock === undefined) {
    delete process.env.TMUX_TEST_SOCK;
  } else {
    process.env.TMUX_TEST_SOCK = savedTmuxSock;
  }
  await rm(dataDir, { recursive: true, force: true });
});

describe("UserPromptSubmit unstuck vs transcript reconciliation", () => {
  test("a prompt-unstuck session is not re-enqueued from a stale transcript tail", async () => {
    const sessionId = "unstuck-stale-tail";
    const transcriptPath = await writeTranscript("stale-tail.jsonl", [
      assistantAt(1000),
    ]);
    // Not queued: the session was stuck (last_stuck_at retained) and then the
    // operator submitted a prompt, which marked it unstuck at 2000.
    upsertSession(sessionId, paneId, dataDir, transcriptPath, 1000, "stopped", "waiting for input");
    markSessionUnstuck(sessionId, 2000);

    try {
      const result = reconcileStuckDirection();
      expect(result.enqueued).toBe(0);
      expect(liveQueueCount(sessionId)).toBe(0);
    } finally {
      deleteSession(sessionId);
    }
  });

  test("the same stale tail without an unstuck marker still enqueues", async () => {
    const sessionId = "stuck-stale-tail-no-marker";
    const transcriptPath = await writeTranscript("stale-tail-no-marker.jsonl", [
      assistantAt(1000),
    ]);
    upsertSession(sessionId, paneId, dataDir, transcriptPath, 1000, "stopped", "waiting for input");

    try {
      const result = reconcileStuckDirection();
      expect(result.enqueued).toBe(1);
      expect(liveQueueCount(sessionId)).toBe(1);
      expect(
        db.query("SELECT stuck_at, reason FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId)
      ).toEqual({ stuck_at: 1000, reason: "stopped" });
    } finally {
      deleteSession(sessionId);
    }
  });

  test("a genuinely newer stuck turn after the prompt still enqueues", async () => {
    const sessionId = "unstuck-then-restuck";
    const transcriptPath = await writeTranscript("unstuck-then-restuck.jsonl", [
      assistantAt(1000),
      userAt(2000), // the prompt that unstuck the session
      assistantAt(3000), // turn finished; no user message after -> stuck again
    ]);
    upsertSession(sessionId, paneId, dataDir, transcriptPath, 1000, "stopped", "waiting for input");
    markSessionUnstuck(sessionId, 2500); // hook arrival after the prompt entry

    try {
      const result = reconcileStuckDirection();
      expect(result.enqueued).toBe(1);
      expect(liveQueueCount(sessionId)).toBe(1);
      expect(
        db.query("SELECT stuck_at FROM queue WHERE session_id = ? AND dequeued_at IS NULL").get(sessionId)
      ).toEqual({ stuck_at: 3000 });
      expect(
        db.query("SELECT last_stuck_at FROM sessions WHERE session_id = ?").get(sessionId)
      ).toEqual({ last_stuck_at: 3000 });
    } finally {
      deleteSession(sessionId);
    }
  });

  test("a flushed prompt entry makes the transcript tail not stuck", async () => {
    const sessionId = "unstuck-flushed-prompt";
    const transcriptPath = await writeTranscript("flushed-prompt.jsonl", [
      assistantAt(1000),
      userAt(2000),
    ]);
    upsertSession(sessionId, paneId, dataDir, transcriptPath, 1000, "stopped", "waiting for input");
    markSessionUnstuck(sessionId, 2500);

    const tail = detectStuckFromTranscriptTail(transcriptPath);
    expect(tail.isStuck).toBe(false);
    expect(tail.lastAssistantTime).toBe(1000);

    try {
      const result = reconcileStuckDirection();
      expect(result.enqueued).toBe(0);
      expect(liveQueueCount(sessionId)).toBe(0);
    } finally {
      deleteSession(sessionId);
    }
  });

  test("the periodic reconcile sweep never re-adds a prompt-unstuck session", () => {
    const sessionId = "unstuck-periodic-sweep";
    // No transcript file: hasTranscriptAdvanced cannot confirm progress, so
    // the only thing keeping the session out of the queue is the unstuck.
    upsertSession(sessionId, paneId, dataDir, join(dataDir, "missing.jsonl"), 1000, "stopped", "waiting for input");
    enqueue(sessionId, "stopped", 1000);
    markSessionUnstuck(sessionId, 2000);

    try {
      expect(hasTranscriptAdvanced(join(dataDir, "missing.jsonl"), 1000)).toBe(false);
      expect(liveQueueCount(sessionId)).toBe(1);

      // Operator submits the prompt -> unstuck path dequeues...
      dequeue(sessionId);
      expect(liveQueueCount(sessionId)).toBe(0);

      // ...and no reconcile direction puts it back.
      const stuck = reconcileStuckDirection();
      expect(liveQueueCount(sessionId)).toBe(0);
      expect(stuck.enqueued).toBe(0);
    } finally {
      deleteSession(sessionId);
    }
  });
});
