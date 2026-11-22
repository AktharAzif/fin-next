// The supervisor end to end, with a stand-in for cloudflared: a small Node script that answers
// `--version`, serves `/ready` on the metrics address it is given, records the environment it was
// started with, and exits on SIGTERM. AC-P0-35's `/readyz` rule and the token rule are checked here.
//
// No stand-in outlives its test. Its first statements make SIGTERM end it at once and make it end
// itself once its parent is gone (a runner killed outright runs no clean-up); then it records its
// pid. Every process a test starts that can start one leads its own process group, and after each
// test endTestProcesses() ends those groups and fails, naming the pid, if a stand-in still runs.
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEAM_VARIABLES } from "@fin/server/seams";
import { TEST_RELEASE } from "@fin/server/testing";
import {
  endTestProcesses,
  exitWithParent,
  isRunning,
  recordPid,
  spawnThenCloseStdout,
  trackGroup,
  watchPidDir,
} from "@fin/server/testing/child";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, cloudflaredArgs, main } from "./main.ts";
import type { Supervisor } from "./supervisor.ts";

/** A complete, valid public-connector environment: only the variable under test is wrong. */
function validEnv(port: number, cloudflared: string): Record<string, string | undefined> {
  return {
    FIN_SERVICE: "cloudflared-public",
    FIN_ENVIRONMENT: "ci",
    FIN_RELEASE: TEST_RELEASE,
    FIN_DRAIN_SECONDS: "5",
    PORT: String(port),
    FIN_TUNNEL_ROLE: "public",
    FIN_ZONE: "staging.example.net",
    FIN_TUNNEL_HOSTS: JSON.stringify({
      api: "gateway.staging.example.net",
      console: "console.staging.example.net",
      verify: "onboard.staging.example.net",
      selfie: "selfie.staging.example.net",
    }),
    TUNNEL_TOKEN: `eyJhIjoi${"x".repeat(60)}`,
    FIN_CLOUDFLARED_PATH: cloudflared,
  };
}

/** The supervisors a test started in this process; one the test did not stop is stopped after it. */
const supervisors: Supervisor[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()));
  await endTestProcesses();
});

afterAll(() => endTestProcesses());

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Writes the stand-in for cloudflared into `dir` and returns its path. It records the environment
 * and arguments it was started with in `dir`/env.json and, when it runs a tunnel, its pid in
 * `dir`/pids for the check after each test. Its first statements can neither throw nor wait:
 * SIGTERM ends it at once (process.exit waits for no open handle, its server's included, and no
 * pending write), and so do its parent going away and a broken pipe to that parent; a server that
 * cannot listen ends it too. Its only writes are one short line each, far below a pipe's buffer,
 * so no write can block it.
 */
function fakeCloudflared(dir: string): string {
  const pids = join(dir, "pids");
  mkdirSync(pids, { recursive: true });
  watchPidDir(pids);
  const fake = join(dir, "fake-cloudflared");
  writeFileSync(
    fake,
    `#!${process.execPath}
process.on("SIGTERM", () => process.exit(0));
${exitWithParent()}
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => process.exit(0));
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("cloudflared version 2026.11.1 (built test)"); process.exit(0); }
${recordPid(pids)}
writeFileSync(${JSON.stringify(join(dir, "env.json"))}, JSON.stringify({ keys: Object.keys(process.env).sort(), args }));
const metrics = args[args.indexOf("--metrics") + 1];
const [host, port] = metrics.split(":");
const server = createServer((req, res) => {
  if (req.url === "/ready") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: 200, readyConnections: 4 })); }
  else { res.writeHead(404); res.end(); }
});
server.on("error", () => process.exit(1));
server.listen(Number(port), host);
console.error("INF Registered tunnel connection connIndex=0 location=lhr01");
`,
  );
  chmodSync(fake, 0o755);
  return fake;
}

interface End {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function ended(child: ChildProcess): Promise<End> {
  return new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
}

/** `promise`'s value, or "running" when it has not settled within `ms`. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | "running"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"running">((resolve) => {
    timer = setTimeout(() => resolve("running"), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** The pid the stand-in in `dir` recorded, once it has (0 if it has not within `ms`). */
async function stubPid(dir: string, ms = 10_000): Promise<number> {
  const end = performance.now() + ms;
  let pid = 0;
  while (pid <= 1 && performance.now() <= end) {
    pid = Number(readdirSync(join(dir, "pids"))[0] ?? 0);
    if (pid <= 1) await new Promise((r) => setTimeout(r, 5));
  }
  return pid;
}

/** Whether `pid` has stopped running within `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (isRunning(pid)) {
    if (performance.now() > end) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

describe("the stand-in for cloudflared", () => {
  /** Starts the stand-in as the supervisor does, but leading its own process group. */
  async function startStub() {
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-stub-"));
    const metrics = `127.0.0.1:${await freePort()}`;
    const child = spawn(fakeCloudflared(dir), cloudflaredArgs(join(dir, "config.yml"), metrics), {
      env: childEnvironment("t"),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    trackGroup(child.pid);
    const spawned = new Promise((resolve) => child.once("spawn", resolve));
    return { dir, child, metrics, spawned, end: ended(child) };
  }

  it("exits 0 on SIGTERM within 3 s once serving, with its output's reader gone", async () => {
    const { child, metrics, end } = await startStub();
    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      ready = await fetch(`http://${metrics}/ready`, { signal: AbortSignal.timeout(1000) }).then(
        (response) => response.ok,
        () => false,
      );
      if (!ready) await new Promise((r) => setTimeout(r, 50));
    }
    expect(ready).toBe(true);
    child.stdout.destroy();
    child.stderr.destroy();
    child.kill("SIGTERM");
    expect(await within(end, 3000)).toEqual({ code: 0, signal: null });
  }, 20_000);

  it("exits 0 on SIGTERM within 3 s sent the moment it has started, before its server serves", async () => {
    const { dir, child, end } = await startStub();
    expect(await stubPid(dir)).toBe(child.pid);
    child.kill("SIGTERM");
    expect(await within(end, 3000)).toEqual({ code: 0, signal: null });
  }, 20_000);

  it("ends on SIGTERM within 3 s sent as soon as it is spawned, before any of its code runs", async () => {
    const { child, spawned, end } = await startStub();
    await spawned;
    child.kill("SIGTERM");
    expect(await within(end, 3000)).not.toBe("running");
  }, 20_000);

  it("exits by itself within 5 s when its parent dies without ending it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-orphan-"));
    const fake = fakeCloudflared(dir);
    const args = cloudflaredArgs(join(dir, "config.yml"), `127.0.0.1:${await freePort()}`);
    // A parent that starts the stand-in as the supervisor does, then is killed outright.
    const parent = spawn(
      process.execPath,
      [
        "-e",
        `${exitWithParent(process.pid)}
const child = require("node:child_process").spawn(${JSON.stringify(fake)}, ${JSON.stringify(args)}, { env: ${JSON.stringify(childEnvironment("t"))}, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.resume();
child.stderr.resume();
setInterval(() => {}, 1000);`,
      ],
      { stdio: "ignore", detached: true },
    );
    trackGroup(parent.pid);
    const parentEnd = ended(parent);
    const stub = await stubPid(dir);
    expect(stub).toBeGreaterThan(1);
    parent.kill("SIGKILL");
    await parentEnd;
    expect(await goneWithin(stub, 5000), `the stand-in (pid ${stub}) outlived its parent`).toBe(
      true,
    );
  }, 20_000);
});

describe("main", () => {
  it("renders the configuration, starts cloudflared with only the token, and answers /readyz", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-main-"));
    const fake = fakeCloudflared(dir);
    const [healthPort, metricsPort] = [await freePort(), await freePort()];
    const token = `eyJhIjoi${"x".repeat(60)}`;
    const lines: Record<string, unknown>[] = [];
    const exits: number[] = [];
    const supervisor = await main({
      env: {
        FIN_SERVICE: "cloudflared-public",
        FIN_ENVIRONMENT: "ci",
        FIN_RELEASE: TEST_RELEASE,
        FIN_DRAIN_SECONDS: "5",
        PORT: String(healthPort),
        FIN_TUNNEL_ROLE: "public",
        FIN_ZONE: "staging.example.net",
        FIN_TUNNEL_HOSTS: JSON.stringify({
          api: "gateway.staging.example.net",
          console: "console.staging.example.net",
          verify: "onboard.staging.example.net",
          selfie: "selfie.staging.example.net",
        }),
        TUNNEL_TOKEN: token,
        FIN_CLOUDFLARED_PATH: fake,
        FIN_TELEMETRY_TOKEN: undefined,
      },
      exit: (code) => exits.push(code),
      configPath: join(dir, "cloudflared", "config.yml"),
      metrics: `127.0.0.1:${metricsPort}`,
      host: "127.0.0.1",
      signals: false,
      stdout: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    if (supervisor !== undefined) supervisors.push(supervisor);
    expect(supervisor).toBeDefined();
    if (supervisor === undefined) return;
    const readyz = () => fetch(`http://127.0.0.1:${healthPort}/readyz`).then((r) => r.status);
    expect(await readyz()).toBe(503);
    for (let i = 0; i < 50 && !existsSync(join(dir, "env.json")); i++)
      await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 100));
    await supervisor.poll();
    expect(supervisor.state).toBe("ready");
    expect(await readyz()).toBe(200);
    expect((await fetch(`http://127.0.0.1:${healthPort}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${healthPort}/metrics`)).status).toBe(404);

    const seen = JSON.parse(readFileSync(join(dir, "env.json"), "utf8")) as {
      keys: string[];
      args: string[];
    };
    // macOS adds its own __CF_USER_TEXT_ENCODING to every process; Linux adds nothing.
    expect(seen.keys.filter((k) => !k.startsWith("__CF_"))).toEqual(["HOME", "TUNNEL_TOKEN"]);
    expect(seen.args.join(" ")).not.toContain(token);
    expect(seen.args).toEqual(
      cloudflaredArgs(join(dir, "cloudflared", "config.yml"), `127.0.0.1:${metricsPort}`),
    );
    expect(readFileSync(join(dir, "cloudflared", "config.yml"), "utf8")).toContain(
      'path: "^/api/"',
    );
    expect(JSON.stringify(lines)).not.toContain(token);
    expect(lines.find((l) => l.event === "process.start")).toMatchObject({
      version: "2026.11.1",
      tunnel: "public",
    });

    await supervisor.stop();
    expect(exits).toEqual([0]);
    expect(lines.some((l) => l.event === "connector.cloudflared_log")).toBe(true);
  }, 20_000);

  it("exits 78 naming TUNNEL_TOKEN when it is missing, never printing a value", async () => {
    const lines: string[] = [];
    const exits: number[] = [];
    await main({
      env: {
        FIN_SERVICE: "cloudflared-public-b",
        FIN_ENVIRONMENT: "ci",
        FIN_RELEASE: TEST_RELEASE,
        FIN_DRAIN_SECONDS: "35",
        FIN_TUNNEL_ROLE: "public",
        FIN_ZONE: "staging.example.net",
        FIN_TUNNEL_HOSTS: "{}",
      },
      exit: (code) => exits.push(code),
      signals: false,
      stdout: (line) => lines.push(line),
    });
    expect(exits).toEqual([78]);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      event: "config.invalid",
      variable: "TUNNEL_TOKEN",
      problem: "missing",
    });
  });

  it("gives the child nothing but the token and a home", () => {
    expect(childEnvironment("t")).toEqual({ TUNNEL_TOKEN: "t", HOME: "/tmp" });
  });

  it("built for release, exits 78 naming each seam variable, before reading anything else", async () => {
    // What Vite's define compiles into the release bundle (packages/server/src/build).
    vi.stubGlobal("__FIN_BUILD_TARGET__", "release");
    for (const name of [...SEAM_VARIABLES, "FIN_SEAM_clock"]) {
      const lines: Record<string, unknown>[] = [];
      const exits: number[] = [];
      const supervisor = await main({
        env: { ...validEnv(await freePort(), "/nonexistent/cloudflared"), [name]: "1" },
        exit: (code) => exits.push(code),
        signals: false,
        stdout: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      });
      expect(supervisor, name).toBeUndefined();
      expect(exits, name).toEqual([78]);
      expect(lines, name).toEqual([
        expect.objectContaining({
          event: "config.invalid",
          variable: name === "FIN_SEAM_clock" ? "FIN_SEAM" : name,
          problem: "refused",
        }),
      ]);
    }
  });

  it("exits 78 for NODE_OPTIONS: the command carries Node's flags", async () => {
    const lines: Record<string, unknown>[] = [];
    const exits: number[] = [];
    await main({
      env: { ...validEnv(await freePort(), "/nonexistent/cloudflared"), NODE_OPTIONS: "--inspect" },
      exit: (code) => exits.push(code),
      signals: false,
      stdout: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    expect(exits).toEqual([78]);
    expect(lines[0]).toMatchObject({ variable: "NODE_OPTIONS", problem: "refused" });
  });

  it("exits 1 with process.start_failed when its health port is taken, rather than idle", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const address = taken.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-port-"));
    try {
      const lines: Record<string, unknown>[] = [];
      const exits: number[] = [];
      const supervisor = await main({
        env: validEnv(port, join(dir, "no-such-cloudflared")),
        exit: (code) => exits.push(code),
        configPath: join(dir, "cloudflared", "config.yml"),
        host: "127.0.0.1",
        signals: false,
        stdout: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
      });
      expect(supervisor).toBeUndefined();
      expect(exits).toEqual([1]);
      expect(lines.at(-1)).toMatchObject({
        event: "process.start_failed",
        errorCode: "EADDRINUSE",
      });
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it("writes connector.exited with spawn_failed and exits 1 when cloudflared is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-missing-"));
    const lines: Record<string, unknown>[] = [];
    const exits: number[] = [];
    await main({
      env: validEnv(await freePort(), join(dir, "no-such-cloudflared")),
      exit: (code) => exits.push(code),
      configPath: join(dir, "cloudflared", "config.yml"),
      metrics: `127.0.0.1:${await freePort()}`,
      host: "127.0.0.1",
      signals: false,
      stdout: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    for (let i = 0; i < 100 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([1]);
    expect(lines.filter((l) => l.event === "connector.exited")).toEqual([
      expect.objectContaining({ reason: "spawn_failed", exitCode: 1 }),
    ]);
    expect(lines.at(-1)?.event).toBe("connector.exited");
  }, 20_000);
});

/**
 * The supervisor run as its own process, as the image runs it (signal and crash handlers on), with
 * the stand-in for cloudflared; each byte on stdin throws from a timer, uncaught, and the bytes of
 * one write throw in the same turn of the event loop. It ends itself should this process die.
 */
async function connectorChild(): Promise<{
  dir: string;
  script: string;
  env: Record<string, string>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "fin-connector-stdout-"));
  const fake = fakeCloudflared(dir);
  const script = join(dir, "connector.mjs");
  writeFileSync(
    script,
    `import { main } from ${JSON.stringify(new URL("./main.ts", import.meta.url).href)};
${exitWithParent(process.pid)}
await main({
  host: "127.0.0.1",
  configPath: ${JSON.stringify(join(dir, "cloudflared", "config.yml"))},
  metrics: ${JSON.stringify(`127.0.0.1:${await freePort()}`)},
});
process.stdin.on("data", (chunk) => {
  for (let i = 0; i < chunk.length; i++) {
    setTimeout(() => {
      throw new Error("planted");
    }, 0);
  }
});
`,
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(validEnv(await freePort(), fake))) {
    if (value !== undefined) env[name] = value;
  }
  return { dir, script, env };
}

describe("main when stdout's reader goes away", () => {
  it("keeps supervising and answering, then exits 0 on SIGTERM within FIN_DRAIN_SECONDS", async () => {
    const { script, env } = await connectorChild();
    const run = await spawnThenCloseStdout(script, env);
    // The first line (process.start) comes just before the health server listens.
    let status = 0;
    for (let i = 0; i < 60 && status !== 200; i++) {
      status = await fetch(`http://127.0.0.1:${env.PORT}/healthz`, {
        signal: AbortSignal.timeout(1000),
      }).then(
        (response) => response.status,
        () => 0,
      );
      if (status !== 200) await new Promise((r) => setTimeout(r, 50));
    }
    expect(status).toBe(200);
    run.child.kill("SIGTERM");
    expect(await run.exit(5000)).toBe(0);
    expect(run.stderr()).toBe("");
  }, 30_000);

  it("still exits 1 within the crash flush on an uncaught exception", async () => {
    const { script, env } = await connectorChild();
    const run = await spawnThenCloseStdout(script, env);
    run.child.stdin.write("x");
    expect(await run.exit(4000)).toBe(1);
    expect(run.stderr()).toBe("");
  }, 30_000);

  it("exits 1 once, within the crash flush, when more exceptions follow the first", async () => {
    const { script, env } = await connectorChild();
    const run = await spawnThenCloseStdout(script, env);
    run.child.stdin.write("xxx");
    expect(await run.exit(4000)).toBe(1);
    expect(run.stderr()).toBe("");
  }, 30_000);

  // A crash exits without stopping cloudflared (in the image, the container ends with its first
  // process and takes cloudflared with it). Outside one, the stand-in must not stay behind: it
  // ends itself once the supervisor is gone, before the clean-up after the test would end it.
  it("leaves no stand-in running once it has exited 1 on an uncaught exception", async () => {
    const { dir, script, env } = await connectorChild();
    const run = await spawnThenCloseStdout(script, env);
    const stub = await stubPid(dir);
    expect(stub).toBeGreaterThan(1);
    run.child.stdin.write("x");
    expect(await run.exit(4000)).toBe(1);
    expect(await goneWithin(stub, 5000), `the stand-in (pid ${stub}) outlived the supervisor`).toBe(
      true,
    );
  }, 30_000);
});
