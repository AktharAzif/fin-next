// The static host's self-test over real sockets (spec 01 §4.7): it serves the fixture app with
// the `app` profile's rendered `_headers`, and a client sees the headers, the single-page fallback
// and the proxying exactly as the zone would answer them (S-01's answers).
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type RunningStaticHost, startStaticHost } from "../src/static-host/server.ts";
import { type FakeApi, startFakeApi } from "./fake-api.ts";

const ROOT = join(import.meta.dirname, "fixtures/app");
const PROOF = ["self", "test", "proof"].join("-");

let api: FakeApi;
let host: RunningStaticHost;

beforeAll(async () => {
  api = await startFakeApi();
  host = await startStaticHost({
    app: "console",
    root: ROOT,
    api: { origin: api.origin, ingressProof: PROOF },
    files: { "/env.json": JSON.stringify({ environment: "ci" }) },
  });
});

afterAll(async () => {
  await host.close();
  await api.close();
});

const get = (path: string, init: RequestInit = {}) =>
  fetch(`${host.origin}${path}`, { redirect: "manual", ...init });

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
    expect(echo.peer).toBe("127.0.0.1");
  });

  it("serves env.json as the deploy renders it", async () => {
    expect(await (await get("/env.json")).json()).toEqual({ environment: "ci" });
  });
});

describe("the command line", () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("starts a host for a role and writes JSON lines, never the proof", async () => {
    child = spawn(
      process.execPath,
      [
        join(import.meta.dirname, "../src/static-host/cli.ts"),
        "--app",
        "docs",
        "--root",
        ROOT,
        "--headers",
        join(ROOT, "_headers"),
        "--port",
        "0",
      ].map(String),
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const seen: string[] = [];
    const waiters: Array<() => void> = [];
    createInterface({ input: child.stdout as NodeJS.ReadableStream }).on("line", (text) => {
      seen.push(text);
      for (const wake of waiters.splice(0)) wake();
    });
    const nextLine = async (index: number): Promise<string> => {
      while (seen.length <= index) await new Promise<void>((wake) => waiters.push(wake));
      return seen[index] as string;
    };
    const first = await nextLine(0);
    const start = JSON.parse(first) as { event: string; origin: string; app: string };
    expect(start).toMatchObject({ event: "process.start", app: "docs" });
    const response = await fetch(`${start.origin}/api/anything`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("STATIC-OK");
    const line = await nextLine(1);
    expect(JSON.parse(line)).toMatchObject({
      event: "request",
      route: "spa-fallback",
      status: 200,
    });
    expect(first + line).not.toContain(PROOF);
  });

  it("refuses an unknown role with exit code 78", async () => {
    const bad = spawn(
      process.execPath,
      [join(import.meta.dirname, "../src/static-host/cli.ts"), "--app", "nope"],
      {
        stdio: "ignore",
      },
    );
    const [code] = (await once(bad, "exit")) as [number];
    expect(code).toBe(78);
  });
});
