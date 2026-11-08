// Scenario harness for the notification acceptance test (daemon/notify.test.ts).
//
// Runs as a child process because bun test executes every *.test.ts in one
// process with a shared module registry: notify.ts reads its configuration
// from the environment at import time and keeps its rate-limit state in
// module scope, and db.ts resolves TRAILBOSS_DATA_DIR at import (see the
// header comment in unstuck-reconcile.test.ts). A child process gives this
// scenario run its own env, its own throwaway data dir, and its own clock
// (setSystemTime) without racing the rest of the suite.
//
// The harness only produces facts: a single JSON report on stdout describing
// every mock-proxy request, every poll step, and everything notify.ts logged.
// Every assertion lives in daemon/notify.test.ts.
import { setSystemTime } from "bun:test";
import { mkdtemp } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Console capture: keep stdout a pristine single JSON document; mirror
// captured lines to stderr so a crashed harness is still diagnosable.
// ---------------------------------------------------------------------------
const consoleOut: string[] = [];
const consoleErr: string[] = [];
const consoleWarn: string[] = [];

function captureConsole(sink: string[], original: (...args: unknown[]) => void): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    sink.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    original(...args);
  };
}
console.log = captureConsole(consoleOut, (...args) => process.stderr.write(args.join(" ") + "\n"));
console.error = captureConsole(consoleErr, (...args) => process.stderr.write(args.join(" ") + "\n"));
console.warn = captureConsole(consoleWarn, (...args) => process.stderr.write(args.join(" ") + "\n"));

// ---------------------------------------------------------------------------
// Mock telegram-claude-bridge proxy: a real HTTP server on loopback so the
// production fetch path in notify.ts is exercised end to end.
// ---------------------------------------------------------------------------
const requests: Array<{ at: number; chat_id: unknown; thread_id: string | null; text: string }> = [];

const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (req) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    requests.push({
      at: Date.now(),
      chat_id: body.chat_id,
      thread_id: typeof body.thread_id === "string" ? body.thread_id : null,
      text: typeof body.text === "string" ? body.text : "",
    });
    return Response.json({ ok: true, message_id: 4242 });
  },
});

// ---------------------------------------------------------------------------
// Configure notify.ts via the environment BEFORE importing it (module-scope
// config), with a throwaway data dir for db.ts.
// ---------------------------------------------------------------------------
process.env.TRAILBOSS_DATA_DIR = await mkdtemp("/tmp/trailboss-notify-acceptance-");
process.env.TRAILBOSS_PORT = "0";
process.env.TELEGRAM_PROXY_URL = `http://127.0.0.1:${proxy.port}`;
process.env.TELEGRAM_CHAT_ID = "acceptance-chat";
process.env.TELEGRAM_THREAD_ID = "acceptance-thread";
process.env.NOTIFY_THRESHOLD = "1";
process.env.NOTIFY_COOLDOWN_MS = "3600000"; // 1 hour, the documented default

const { upsertSession, enqueue, dequeue, getStuckCount, getHead } = await import("./db.ts");
const { checkAndNotify } = await import("./notify.ts");

// Distinct 8-character prefixes: the alert message shows
// head.session_id.slice(0, 8), so each session must be recognizable in text.
const SESSION_A = "notify-a-11111111";
const SESSION_B = "notify-b-22222222";
const SESSION_C = "notify-c-33333333";

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0); // 2026-11-08T12:00:00Z
const COOLDOWN_MS = 3_600_000;

const steps: Array<{
  step: string;
  fakeNow: number;
  stuckCount: number;
  headSessionId: string | null;
  requestCount: number;
}> = [];

async function poll(step: string): Promise<void> {
  await checkAndNotify();
  steps.push({
    step,
    fakeNow: Date.now(),
    stuckCount: getStuckCount(),
    headSessionId: getHead()?.session_id ?? null,
    requestCount: requests.length,
  });
}

function stuck(sessionId: string, reason: string, atMs: number): void {
  upsertSession(sessionId, `%${sessionId.slice(-4)}`, "/home/coding/acceptance", `/tmp/${sessionId}.jsonl`, atMs, reason, "acceptance stub");
  enqueue(sessionId, reason, atMs);
}

// S0 — below threshold: empty queue, first poll must not alert.
setSystemTime(T0);
await poll("initial_empty_queue");

// S1 — threshold crossing: first stuck session reaches the head.
setSystemTime(T0 + 5_000);
stuck(SESSION_A, "stopped", T0 + 5_000);
await poll("threshold_crossed"); // expect alert #1

// S2 — sub-cooldown polls with an unchanged head must not alert.
setSystemTime(T0 + 20_000);
await poll("cooldown_poll_1");
setSystemTime(T0 + 35_000);
await poll("cooldown_poll_2");

// S3 — a new session reaches the head (A resolved, B queued behind it):
// the documented cooldown reset means B re-alerts even though the last
// alert was 45s ago (well inside the 1h cooldown).
setSystemTime(T0 + 40_000);
stuck(SESSION_B, "permission", T0 + 40_000);
dequeue(SESSION_A);
setSystemTime(T0 + 50_000);
await poll("head_changed"); // expect alert #2

// S4 — identical head, cooldown expired: dedup on the last-notified head
// session ID must still suppress the alert.
setSystemTime(T0 + 50_000 + COOLDOWN_MS + 10_000);
await poll("dedup_after_cooldown"); // expect no alert

// S5 — proxy down: new head C, proxy listener closed. checkAndNotify must
// log the failure to stderr and return without throwing.
setSystemTime(T0 + 50_000 + COOLDOWN_MS + 20_000);
stuck(SESSION_C, "stopped", T0 + 50_000 + COOLDOWN_MS + 20_000);
dequeue(SESSION_B);
await proxy.stop(true);
setSystemTime(T0 + 50_000 + COOLDOWN_MS + 30_000);
await poll("proxy_down"); // expect no alert, no crash

process.stdout.write(
  JSON.stringify({
    proxyPort: proxy.port,
    sessionIds: { a: SESSION_A, b: SESSION_B, c: SESSION_C },
    requests,
    steps,
    consoleOut,
    consoleErr,
    consoleWarn,
  })
);
