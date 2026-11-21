// The static host's self-test over real sockets (spec 01 §4.7): it serves the fixture app with
// the `app` profile's rendered `_headers`, over https under its own name, and a client sees the
// headers, the single-page fallback and the proxying exactly as the zone would answer them
// (S-01's answers). The command line is run as Playwright runs it.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodeToken } from "../src/access/jwt.ts";
import { CANON_TIME } from "../src/clock.ts";
import { forward } from "../src/http/node.ts";
import type { RequestLine } from "../src/static-host/host.ts";
import { type RunningStaticHost, startStaticHost } from "../src/static-host/server.ts";
import { type FakeApi, startFakeApi } from "./fake-api.ts";

const ROOT = join(import.meta.dirname, "fixtures/app");
const CLI = join(import.meta.dirname, "../src/static-host/cli.ts");
const PROOF = ["self", "test", "proof"].join("-");

let api: FakeApi;
let host: RunningStaticHost;
const lines: RequestLine[] = [];

beforeAll(async () => {
  api = await startFakeApi();
  host = await startStaticHost({
    app: "console",
    root: ROOT,
    name: "console.localhost",
    api: { origin: api.origin, ingressProof: PROOF },
    files: { "/env.json": JSON.stringify({ environment: "ci" }) },
    log: (line) => lines.push(line),
  });
});

afterAll(async () => {
  await host.close();
  await api.close();
});

interface Init {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly host?: string;
}

/** A request to a host over TLS, trusting only its own certificate, by its bound address. */
function send(
  target: { readonly loopbackOrigin: string; readonly authority: string },
  path: string,
  ca: string | undefined,
  init: Init = {},
) {
  return forward(
    target.loopbackOrigin,
    {
      method: init.method ?? "GET",
      target: path,
      headers: [["Host", init.host ?? target.authority], ...Object.entries(init.headers ?? {})],
      body: init.body === undefined ? null : new Response(init.body).body,
    },
    ca === undefined ? {} : { ca },
  );
}

const get = (path: string, init: Init = {}) => send(host, path, host.certificate, init);

describe("https under the host's own name", () => {
  it("answers at https://console.localhost:<port>, bound to 127.0.0.1", () => {
    expect(host.origin).toBe(`https://console.localhost:${host.port}`);
    expect(host.loopbackOrigin).toBe(`https://127.0.0.1:${host.port}`);
    expect(host.certificate).toContain("BEGIN CERTIFICATE");
  });

  it("is refused by a client that does not trust its certificate", async () => {
    await expect(send(host, "/", undefined)).rejects.toThrow();
  });

  it("answers another Host with 421 and a request line, and serves nothing", async () => {
    const before = api.received.length;
    for (const foreign of [`attacker.example:${host.port}`, `admin.localhost:${host.port}`]) {
      const response = await get("/api/ping", { host: foreign });
      expect(response.status).toBe(421);
    }
    expect(api.received.length).toBe(before);
    expect(lines.filter((line) => line.route === "misdirected").map((l) => l.status)).toEqual([
      421, 421,
    ]);
  });
});

describe("headers", () => {
  it("sends the profile on the document and one Cache-Control on an asset", async () => {
    const page = await get("/");
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-cache");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(page.headers.get("reporting-endpoints")).toBe('csp="/api/monitoring/csp"');
    const asset = await get("/assets/app.css");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(asset.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await asset.text()).toMatch(/^@layer ui-sdk;/);
  });
});

describe("the single-page fallback", () => {
  it("answers a deep link and an unknown asset with index.html and 200", async () => {
    for (const path of ["/settings/team", "/assets/old-chunk.js"]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("STATIC-OK");
    }
    const unknownAsset = await get("/assets/old-chunk.js");
    expect(unknownAsset.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses source maps and redirects to canonical paths", async () => {
    expect((await get("/assets/app.js.map")).status).toBe(404);
    const redirect = await get("/guide");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/guide/");
  });
});

describe("proxying /api/", () => {
  it("forwards a JSON POST with its body, the browser's Host and the ingress proof", async () => {
    const response = await get("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", "x-fin-app": "console", origin: host.origin },
      body: JSON.stringify({ email: "asha.rao@example.com" }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.has("content-security-policy")).toBe(false);
    const echo = (await response.json()) as {
      host: string;
      body: string;
      headers: [string, string][];
      peer: string;
    };
    expect(echo.host).toBe(host.authority);
    expect(echo.body).toBe('{"email":"asha.rao@example.com"}');
    expect(echo.headers).toContainEqual(["Fin-Ingress-Proof", PROOF]);
    expect(echo.headers).toContainEqual(["x-fin-app", "console"]);
    expect(echo.headers).toContainEqual(["origin", host.origin]);
    expect(echo.peer).toBe("127.0.0.1");
  });

  it("serves env.json as the deploy renders it", async () => {
    expect(await (await get("/env.json")).json()).toEqual({ environment: "ci" });
  });
});

interface Cli {
  readonly stdout: string[];
  readonly stderr: () => string;
  line(index: number): Promise<string>;
  stop(): Promise<void>;
}

/** Runs the command line as Playwright's webServer does, and reads what it prints. */
function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Cli {
  const child: ChildProcess = spawn(process.execPath, [CLI, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FIN_E2E_CLOCK: "", FIN_E2E_INGRESS_PROOF: "", ...env },
  });
  const stdout: string[] = [];
  let stderr = "";
  const waiters: Array<() => void> = [];
  createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
    stdout.push(text);
    for (const wake of waiters.splice(0)) wake();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = once(child, "exit");
  return {
    stdout,
    stderr: () => stderr,
    async line(index) {
      while (stdout.length <= index) {
        if (child.exitCode !== null) throw new Error(`the CLI exited: ${stderr}`);
        await new Promise<void>((wake) => {
          waiters.push(wake);
          setTimeout(wake, 200);
        });
      }
      return stdout[index] as string;
    },
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
    },
  };
}

interface Start {
  readonly event: string;
  readonly app: string;
  readonly origin: string;
  readonly access: string | null;
  readonly clock: string;
}

describe("the command line", () => {
  const scratch = mkdtempSync(join(tmpdir(), "fin-testing-cli-"));
  const running: Cli[] = [];
  afterAll(async () => {
    await Promise.all(running.map((cli) => cli.stop()));
    rmSync(scratch, { recursive: true, force: true });
  });

  function start(args: readonly string[], env: NodeJS.ProcessEnv = {}): Cli {
    const cli = runCli(
      ["--root", ROOT, "--headers", join(ROOT, "_headers"), "--port", "0", ...args],
      env,
    );
    running.push(cli);
    return cli;
  }

  /** The host the CLI started, addressed through its bound address and its own certificate. */
  function target(startLine: Start, certFile: string) {
    const origin = new URL(startLine.origin);
    return {
      authority: origin.host,
      loopbackOrigin: `https://127.0.0.1:${origin.port}`,
      ca: readFileSync(certFile, "utf8"),
    };
  }

  it("starts a host for a role over https under its name, and writes JSON lines", async () => {
    const cert = join(scratch, "docs.pem");
    const cli = start(["--app", "docs", "--cert-out", cert]);
    const begun = JSON.parse(await cli.line(0)) as Start;
    expect(begun).toMatchObject({ event: "process.start", app: "docs", access: null });
    expect(begun.origin).toMatch(/^https:\/\/docs\.localhost:\d+$/);
    expect(begun.clock).toBe(CANON_TIME);
    const docs = target(begun, cert);
    const response = await send(docs, "/api/anything", docs.ca);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("STATIC-OK");
    expect(JSON.parse(await cli.line(1))).toMatchObject({
      event: "request",
      route: "spa-fallback",
      status: 200,
    });
  });

  it("sends the ingress proof to the API half and never prints it", async () => {
    // A value made for this run, so no other source could have printed it.
    const proof = `cli-proof-${randomBytes(12).toString("base64url")}`;
    const cert = join(scratch, "console.pem");
    const cli = start(["--app", "console", "--api", api.origin, "--cert-out", cert], {
      FIN_E2E_INGRESS_PROOF: proof,
    });
    const begun = JSON.parse(await cli.line(0)) as Start;
    expect(begun.origin).toMatch(/^https:\/\/console\.localhost:\d+$/);
    const consoleHost = target(begun, cert);
    const response = await send(consoleHost, "/api/ping", consoleHost.ca, {
      method: "POST",
      headers: { "content-type": "application/json", "x-fin-app": "console" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    const echo = (await response.json()) as { headers: [string, string][] };
    expect(echo.headers).toContainEqual(["Fin-Ingress-Proof", proof]);
    expect(JSON.parse(await cli.line(1))).toMatchObject({ route: "api", status: 200 });
    await cli.stop();
    expect(cli.stdout.length).toBeGreaterThanOrEqual(2);
    for (const printed of [...cli.stdout, cli.stderr()]) expect(printed).not.toContain(proof);
  });

  it("signs Access tokens at the run's clock, and its gate checks them at the same time", async () => {
    const when = "2026-11-18T09:00:00.000Z";
    const cert = join(scratch, "admin.pem");
    const cli = start([
      "--app",
      "admin",
      "--api",
      api.origin,
      "--access-port",
      "0",
      "--cert-out",
      cert,
      "--clock",
      when,
    ]);
    const begun = JSON.parse(await cli.line(0)) as Start;
    expect(begun.clock).toBe(when);
    expect(begun.access).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const login = new URL("/cdn-cgi/access/login", begun.access ?? "");
    login.searchParams.set("app", begun.origin);
    login.searchParams.set("redirect_url", "/staff");
    login.searchParams.set("email", "grace.hall@example.com");
    const answer = await fetch(login, { redirect: "manual" });
    expect(answer.status).toBe(302);
    const authorized = new URL(answer.headers.get("location") ?? "");
    expect(authorized.origin).toBe(begun.origin);
    const token = authorized.searchParams.get("token") ?? "";
    const { payload } = decodeToken(token);
    expect(payload).toMatchObject({ iat: Date.parse(when) / 1000, nbf: Date.parse(when) / 1000 });
    const admin = target(begun, cert);
    const page = await send(admin, "/staff", admin.ca, {
      headers: { cookie: `CF_Authorization=${token}` },
    });
    expect(page.status).toBe(200);
    const set = await send(admin, `/cdn-cgi/access/authorized${authorized.search}`, admin.ca);
    expect(set.headers.get("set-cookie")).toMatch(/; Secure$/);
  });

  it("signs at the canon's time when no clock is given", async () => {
    const cli = start(["--app", "admin", "--no-api", "--access-port", "0"]);
    const begun = JSON.parse(await cli.line(0)) as Start;
    expect(begun.clock).toBe(CANON_TIME);
    const login = new URL("/cdn-cgi/access/login", begun.access ?? "");
    login.searchParams.set("app", begun.origin);
    login.searchParams.set("email", "grace.hall@example.com");
    const answer = await fetch(login, { redirect: "manual" });
    const token = new URL(answer.headers.get("location") ?? "").searchParams.get("token") ?? "";
    expect(decodeToken(token).payload.iat).toBe(Date.parse(CANON_TIME) / 1000);
  });

  it.each([
    [["--app", "nope"], "--app"],
    [["--app", "docs", "--clock", "yesterday"], "--clock"],
  ])("refuses %j with exit code 78, naming the option", async (args, named) => {
    const bad = spawn(
      process.execPath,
      [CLI, "--root", ROOT, "--headers", join(ROOT, "_headers"), "--port", "0", ...args],
      { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, FIN_E2E_CLOCK: "" } },
    );
    let stderr = "";
    bad.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const [code] = (await once(bad, "exit")) as [number];
    expect(code).toBe(78);
    expect(stderr).toContain(named);
  });
});
