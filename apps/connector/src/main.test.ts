// The supervisor end to end, with a stand-in for cloudflared: a small Node script that answers
// `--version`, serves `/ready` on the metrics address it is given, records the environment it was
// started with, and exits on SIGTERM. AC-P0-35's `/readyz` rule and the token rule are checked here.
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_RELEASE } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { childEnvironment, cloudflaredArgs, main } from "./main.ts";

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
});
