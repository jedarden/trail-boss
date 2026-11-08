import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const testRoot = join(repoRoot, "test-results");

type Event = { type: string; sessionId: string; paneId?: string };
type Failure = "unreachable" | "400" | "500" | "timeout";

async function waitFor(description: string, condition: () => boolean, logs: () => string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${description}. Detector log:\n${logs()}`);
}

async function runFailureScenario(failure: Failure): Promise<void> {
  await mkdir(testRoot, { recursive: true });
  const dir = await mkdtemp(join(testRoot, "tmux-detector-"));
  const socket = join(dir, "tmux.sock");
  const tmux = (...args: string[]) => execFileSync("tmux", ["-S", socket, ...args], { encoding: "utf8" }).trim();
  const received: Event[] = [];
  const stalled: Array<(response: Response) => void> = [];
  let responseMode: Failure | "success" = failure;
  let server: ReturnType<typeof Bun.serve> | undefined;
  let detector: ChildProcess | undefined;
  let log = "";

  const startServer = (port: number) => Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch: async (request) => {
      received.push(await request.json() as Event);
      if (responseMode === "400") return Response.json({ error: "bad request" }, { status: 400 });
      if (responseMode === "500") return Response.json({ error: "server failed" }, { status: 500 });
      if (responseMode === "timeout") return new Promise<Response>((resolve) => stalled.push(resolve));
      return Response.json({ ok: true });
    },
  });

  try {
    server = startServer(0);
    const port = server.port;
    if (failure === "unreachable") {
      server.stop(true);
      server = undefined;
    }

    tmux("new-session", "-d", "-s", "submission-test", "sleep 30");
    tmux("select-pane", "-t", "submission-test", "-T", "@tb-submission-test");
    const paneId = tmux("display", "-p", "-t", "submission-test", "#{pane_id}");

    detector = spawn(process.execPath, ["run", "daemon/tmux-detector.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TRAILBOSS_TMUX_SOCKET: socket,
        TRAILBOSS_DAEMON_URL: `http://127.0.0.1:${port}/event/normalized`,
        TRAILBOSS_POLL_INTERVAL_MS: "50",
        TRAILBOSS_QUIET_THRESHOLD_MS: "60000",
        TRAILBOSS_EVENT_TIMEOUT_MS: "150",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    detector.stdout?.on("data", (chunk) => { log += chunk.toString(); });
    detector.stderr?.on("data", (chunk) => { log += chunk.toString(); });

    const expectedError = failure === "400" || failure === "500"
      ? `[emit] Daemon error: ${failure} - ${failure === "400" ? "bad request" : "server failed"}`
      : "[emit] Network error:";
    await waitFor(`${failure} submission error`, () => log.includes(expectedError), () => log);
    expect(log).not.toContain("[detector] poll error:");
    if (failure === "timeout") {
      expect(log).toMatch(/\[emit\] Network error:.*(?:timeout|timed out)/i);
    }

    // A failed registration is discarded. Several later polls must not resend it.
    const pollCount = () => (log.match(/\[detector\] poll:/g) || []).length;
    const pollsAfterError = pollCount();
    responseMode = "success";
    if (!server) server = startServer(port);
    await waitFor("polling after failed submission", () => pollCount() >= pollsAfterError + 3, () => log);
    expect(detector.exitCode).toBeNull();
    expect(received.filter((event) => event.type === "registered")).toHaveLength(failure === "unreachable" ? 0 : 1);

    // A later detector state change still reaches the daemon after the failure.
    tmux("select-pane", "-t", "submission-test", "-T", "no-longer-opted-in");
    await waitFor("ended event after recovery", () => received.some((event) => event.type === "ended"), () => log);
    expect(received.filter((event) => event.type === "ended")).toHaveLength(1);
    const trackedSessionId = log.match(/\[detector\] registered pane \S+ as (\S+)/)?.[1];
    expect(trackedSessionId).toBeDefined();
    expect(received.find((event) => event.type === "ended")?.sessionId).toBe(trackedSessionId);
    const registered = received.find((event) => event.type === "registered");
    if (registered) {
      expect(registered.paneId).toBe(paneId);
      expect(registered.sessionId).toBe(trackedSessionId);
    }
    expect(log).not.toContain("[detector] poll error:");
  } finally {
    detector?.kill("SIGTERM");
    if (detector && detector.exitCode === null) {
      await Promise.race([
        new Promise<void>((resolve) => detector!.once("exit", () => resolve())),
        Bun.sleep(1000),
      ]);
      if (detector.exitCode === null) detector.kill("SIGKILL");
    }
    for (const resolve of stalled) resolve(Response.json({ ok: true }));
    server?.stop(true);
    try { tmux("kill-server"); } catch { /* Already stopped. */ }
    await rm(dir, { recursive: true, force: true });
  }
}

afterAll(async () => {
  // The test directory is shared with other checks; remove only an empty one.
  try { await rm(testRoot); } catch { /* Other results are present. */ }
});

describe("tmux detector event submission failures", () => {
  for (const failure of ["unreachable", "400", "500", "timeout"] as const) {
    test(`${failure}: logs once, keeps polling, and sends a later state change`, async () => {
      await runFailureScenario(failure);
    }, 10000);
  }
});
