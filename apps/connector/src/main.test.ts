// The supervisor end to end, with a stand-in for cloudflared: a small Node script that answers
// `--version`, serves `/ready` on the metrics address it is given, records the environment it was
// started with, and exits on SIGTERM. AC-P0-35's `/readyz` rule and the token rule are checked here.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SEAM_VARIABLES } from "@fin/server/seams";
import { TEST_RELEASE } from "@fin/server/testing";
import { spawnThenCloseStdout } from "@fin/server/testing/child";
import { afterEach, describe, expect, it, vi } from "vitest";
import { childEnvironment, cloudflaredArgs, main } from "./main.ts";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

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

const FAKE = `#!${process.execPath}
const { createServer } = require("node:http");
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("cloudflared version 2026.11.1 (built test)"); process.exit(0); }
writeFileSync(process.env.HOME + "/../fin-fake-env.json", JSON.stringify({ keys: Object.keys(process.env).sort(), args }));
const metrics = args[args.indexOf("--metrics") + 1];
const [host, port] = metrics.split(":");
const server = createServer((req, res) => {
  if (req.url === "/ready") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ status: 200, readyConnections: 4 })); }
  else { res.writeHead(404); res.end(); }
});
server.listen(Number(port), host);
console.error("INF Registered tunnel connection connIndex=0 location=lhr01");
process.on("SIGTERM", () => { server.close(); process.exit(0); });
`;

describe("main", () => {
  it("renders the configuration, starts cloudflared with only the token, and answers /readyz", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fin-connector-main-"));
    const fake = join(dir, "fake-cloudflared");
    writeFileSync(
      fake,
      FAKE.replace(
        'process.env.HOME + "/../fin-fake-env.json"',
        JSON.stringify(join(dir, "env.json")),
      ),
    );
    chmodSync(fake, 0o755);
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
 * the stand-in for cloudflared; a byte on stdin throws from an event handler, uncaught.
 */
async function connectorChild(): Promise<{ script: string; env: Record<string, string> }> {
  const dir = mkdtempSync(join(tmpdir(), "fin-connector-stdout-"));
  const fake = join(dir, "fake-cloudflared");
  writeFileSync(
    fake,
    FAKE.replace(
      'process.env.HOME + "/../fin-fake-env.json"',
      JSON.stringify(join(dir, "env.json")),
    ),
  );
  chmodSync(fake, 0o755);
  const script = join(dir, "connector.mjs");
  writeFileSync(
    script,
    `import { main } from ${JSON.stringify(new URL("./main.ts", import.meta.url).href)};
await main({
  host: "127.0.0.1",
  configPath: ${JSON.stringify(join(dir, "cloudflared", "config.yml"))},
  metrics: ${JSON.stringify(`127.0.0.1:${await freePort()}`)},
});
process.stdin.on("data", () => {
  throw new Error("planted");
});
`,
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(validEnv(await freePort(), fake))) {
    if (value !== undefined) env[name] = value;
  }
  return { script, env };
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
});
