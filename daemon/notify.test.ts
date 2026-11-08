// Automated acceptance test for the Telegram notification pipeline:
// threshold crossing, sub-cooldown suppression, per-head cooldown reset,
// head deduplication, and graceful degradation when the proxy is down
// (trailbos-8ce8b02f; spec: docs/notes/notifications.md).
//
// The scenarios run in a child process (daemon/notify-acceptance.ts) against
// a real mock telegram-claude-bridge proxy over HTTP, a throwaway data dir,
// and a fully controlled clock — see that file for why. This file owns every
// assertion; the child only reports facts.
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

const HARNESS = join(import.meta.dir, "notify-acceptance.ts");
const HARNESS_TIMEOUT_MS = 30_000;

interface Report {
  proxyPort: number;
  sessionIds: { a: string; b: string; c: string };
  requests: Array<{ at: number; chat_id: unknown; thread_id: string | null; text: string }>;
  steps: Array<{
    step: string;
    fakeNow: number;
    stuckCount: number;
    headSessionId: string | null;
    requestCount: number;
  }>;
  consoleOut: string[];
  consoleErr: string[];
  consoleWarn: string[];
}

let report: Report;

beforeAll(async () => {
  const child = Bun.spawn([process.execPath, HARNESS], {
    cwd: import.meta.dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const killer = setTimeout(() => child.kill(), HARNESS_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(killer);

  if (exitCode !== 0) {
    throw new Error(`notify-acceptance harness exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  try {
    report = JSON.parse(stdout) as Report;
  } catch (err) {
    throw new Error(`harness stdout was not a JSON report: ${err}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
});

function step(name: string): Report["steps"][number] {
  const found = report.steps.find((s) => s.step === name);
  if (!found) {
    throw new Error(`harness report has no step '${name}'; report:\n${JSON.stringify(report, null, 2)}`);
  }
  return found;
}

describe("notification acceptance (threshold / cooldown / dedup / proxy-down)", () => {
  test("harness ran every scenario poll", () => {
    expect(report.steps.map((s) => s.step)).toEqual([
      "initial_empty_queue",
      "threshold_crossed",
      "cooldown_poll_1",
      "cooldown_poll_2",
      "head_changed",
      "dedup_after_cooldown",
      "proxy_down",
    ]);
  });

  test("below threshold: an empty queue never alerts", () => {
    expect(step("initial_empty_queue").stuckCount).toBe(0);
    expect(step("initial_empty_queue").requestCount).toBe(0);
  });

  test("threshold crossing sends exactly one alert, correctly addressed", () => {
    const crossing = step("threshold_crossed");
    expect(crossing.stuckCount).toBe(1);
    expect(crossing.requestCount).toBe(1);

    expect(report.requests[0].chat_id).toBe("acceptance-chat");
    expect(report.requests[0].thread_id).toBe("acceptance-thread");
    const text = report.requests[0].text;
    expect(text).toContain("Trail Boss Alert");
    expect(text).toContain("Queue depth: **1** stuck session");
    expect(text).toContain(`**Head:** ${report.sessionIds.a.slice(0, 8)} (stopped)`);
  });

  test("sub-cooldown polls with an unchanged head send nothing", () => {
    expect(step("cooldown_poll_1").requestCount).toBe(1);
    expect(step("cooldown_poll_2").requestCount).toBe(1);
    expect(report.consoleOut.some((line) => line.includes("[notify] in cooldown period"))).toBe(true);
  });

  test("a changed head session re-alerts within the cooldown window", () => {
    // The last alert fired 45s earlier (fake clock); the documented
    // per-head cooldown reset means the new head must alert anyway.
    const changed = step("head_changed");
    expect(changed.headSessionId).toBe(report.sessionIds.b);
    expect(changed.fakeNow - step("threshold_crossed").fakeNow).toBeLessThan(3_600_000);
    expect(changed.requestCount).toBe(2);

    expect(report.requests[1].text).toContain(`**Head:** ${report.sessionIds.b.slice(0, 8)} (permission)`);
  });

  test("an identical head does not re-alert even after the cooldown expires", () => {
    const dedup = step("dedup_after_cooldown");
    expect(dedup.headSessionId).toBe(report.sessionIds.b);
    // Cooldown genuinely expired relative to the last alert...
    expect(dedup.fakeNow - step("head_changed").fakeNow).toBeGreaterThanOrEqual(3_600_000);
    // ...yet dedup on the last-notified head session ID suppresses it.
    expect(dedup.requestCount).toBe(2);
    expect(report.consoleOut.some((line) => line.includes("[notify] already notified for this head item"))).toBe(true);
  });

  test("proxy down: logs to stderr and does not crash", () => {
    const down = step("proxy_down");
    expect(down.headSessionId).toBe(report.sessionIds.c);
    expect(down.requestCount).toBe(2); // nothing delivered while the proxy was down

    const failures = report.consoleErr.filter((line) => line.includes("[notify] failed to send notification"));
    expect(failures.length).toBeGreaterThan(0);

    // Reaching this assertion at all means the harness (and therefore
    // checkAndNotify through the whole poll) survived the failed send.
    expect(report.steps[report.steps.length - 1].step).toBe("proxy_down");
    expect(report.requests.length).toBe(2);
  });
});
