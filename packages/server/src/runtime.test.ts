import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ConfigError } from "@fin/core";
import { Hono } from "hono";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { SEAM_VARIABLES } from "./config/seams.ts";
import { privateHealth } from "./health/readiness.ts";
import type { FinEnv } from "./http/context.ts";
import { errorHandler, notFoundHandler, requestUnit } from "./http/request.ts";
import { runService, type ServiceDefinition } from "./runtime.ts";
import type { Transport } from "./telemetry/ship.ts";
import { baseEnv, type Line } from "./testing/capture.ts";
import {
  endTestProcesses,
  exitWithParent,
  freePort,
  spawnThenCloseStdout,
} from "./testing/child.ts";

// A service child started by a test never outlives it: its process group is ended after each
// test, which fails naming the pid if it still runs, and it ends itself should this process die.
afterEach(async () => {
  vi.unstubAllGlobals();
  await endTestProcesses();
});

afterAll(() => endTestProcesses());

/** A run whose build fails, recording what had been shipped when it exits. */
async function failedBuild(error: Error): Promise<{ exits: number[]; atExit: string[][] }> {
  const shipped: Line[] = [];
  const transport: Transport = async (body) => {
    shipped.push(...(JSON.parse(gunzipSync(body).toString("utf8")) as Line[]));
    return 202;
  };
  const exits: number[] = [];
  const atExit: string[][] = [];
  await runService(
    {
      services: ["api"],
      build: () => {
        throw error;
      },
    },
    {
      env: baseEnv("api"),
      exit: (code) => {
        exits.push(code);
        atExit.push(shipped.map((l) => String(l.event)));
      },
      processHandlers: false,
      host: "127.0.0.1",
      port: 0,
      stdout: () => undefined,
      transport,
    },
  );
  return { exits, atExit };
}

const definition: ServiceDefinition = {
  services: ["api"],
  build: (ctx) => {
    const options = {
      telemetry: ctx.telemetry,
      reporter: ctx.reporter,
      clock: ctx.clock,
      docsOrigin: "https://docs.example.net",
    };
    const app = new Hono<FinEnv>();
    app.use(requestUnit(options));
    app.use(privateHealth({ readiness: ctx.readiness, notFound: notFoundHandler(options) }));
    app.get("/boom", () => {
      throw new Error("boom");
    });
    app.notFound(notFoundHandler(options));
    app.onError(errorHandler(options));
    return { fetch: app.fetch };
  },
};

function harness(env: Record<string, string>) {
  const stdout: Line[] = [];
  const exits: number[] = [];
  const run = runService(definition, {
    env,
    exit: (code) => exits.push(code),
    processHandlers: false,
    host: "127.0.0.1",
    port: 0,
    stdout: (text) => stdout.push(JSON.parse(text) as Line),
  });
  return { run, stdout, exits };
}

describe("runService", () => {
  it("exits 78 naming a missing variable, never a value", async () => {
    const env = baseEnv("api");
    delete env.FIN_DRAIN_SECONDS;
    const { run, stdout, exits } = harness(env);
    expect(await run).toBeUndefined();
    expect(exits).toEqual([78]);
    expect(stdout).toEqual([
      expect.objectContaining({
        event: "config.invalid",
        variable: "FIN_DRAIN_SECONDS",
        problem: "missing",
        service: "api",
      }),
    ]);
  });

  it("exits 78 for a malformed variable without printing it", async () => {
    const secret = ["tok", "en"].join("") + "x".repeat(30);
    const { run, stdout, exits } = harness(
      baseEnv("api", { FIN_TELEMETRY_HOST: "s1.example.net", FIN_TELEMETRY_TOKEN: `${secret}!` }),
    );
    await run;
    expect(exits).toEqual([78]);
    expect(stdout[0]).toMatchObject({ variable: "FIN_TELEMETRY_TOKEN", problem: "malformed" });
    expect(JSON.stringify(stdout)).not.toContain(secret);
  });

  it("never echoes a FIN_SERVICE value it refuses", async () => {
    const value = ["hunter2", "is", "my", "password"].join("-");
    const { run, stdout, exits } = harness(baseEnv("api", { FIN_SERVICE: value }));
    await run;
    expect(exits).toEqual([78]);
    expect(stdout[0]).toMatchObject({ variable: "FIN_SERVICE", problem: "malformed" });
    expect(stdout[0]?.service).toBeUndefined();
    expect(JSON.stringify(stdout)).not.toContain(value);
  });

  it("built for release, exits 78 naming a seam variable, before reading the configuration", async () => {
    vi.stubGlobal("__FIN_BUILD_TARGET__", "release");
    for (const name of SEAM_VARIABLES) {
      const env = baseEnv("api", { [name]: "1" });
      delete env.FIN_RELEASE;
      const { run, stdout, exits } = harness(env);
      expect(await run, name).toBeUndefined();
      expect(exits, name).toEqual([78]);
      expect(stdout[0], name).toMatchObject({ variable: name, problem: "refused" });
    }
  });

  it("has config.invalid shipped when a failed build exits 78", async () => {
    const { exits, atExit } = await failedBuild(new ConfigError("FIN_DOCS_ORIGIN", "missing"));
    expect(exits).toEqual([78]);
    expect(atExit[0]).toEqual(["config.invalid"]);
  });

  it("exits 1 with process.start_failed when it cannot listen, rather than run with no server", async () => {
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    const port = (taken.address() as AddressInfo).port;
    try {
      const stdout: Line[] = [];
      const exits: number[] = [];
      const service = await runService(definition, {
        env: baseEnv("api"),
        exit: (code) => exits.push(code),
        processHandlers: false,
        host: "127.0.0.1",
        port,
        stdout: (text) => stdout.push(JSON.parse(text) as Line),
      });
      expect(service).toBeUndefined();
      expect(exits).toEqual([1]);
      expect(stdout.find((l) => l.event === "process.start_failed")).toMatchObject({
        errorCode: "EADDRINUSE",
        level: "error",
      });
      expect(stdout.some((l) => l.event === "process.start")).toBe(false);
    } finally {
      await new Promise((resolve) => taken.close(resolve));
    }
  });

  it("has process.start_failed and error.unexpected shipped when a failed build exits 1", async () => {
    const { exits, atExit } = await failedBuild(new TypeError("boom"));
    expect(exits).toEqual([1]);
    expect([...(atExit[0] ?? [])].sort()).toEqual(["error.unexpected", "process.start_failed"]);
  });

  it("exits 78 when the entry does not run that service, and when a forbidden setting is set", async () => {
    expect((await harness(baseEnv("console")).run) === undefined).toBe(true);
    const forbidden = harness(
      baseEnv("api", { BETTER_AUTH_TRUSTED_ORIGINS: "https://x.example.com" }),
    );
    await forbidden.run;
    expect(forbidden.exits).toEqual([78]);
  });

  it("boots, answers its private health, writes process.start and drains on shutdown", async () => {
    const { run, stdout, exits } = harness(baseEnv("api", { FIN_DRAIN_SECONDS: "5" }));
    const service = await run;
    expect(service).toBeDefined();
    if (service === undefined) return;
    const base = `http://127.0.0.1:${service.port}`;
    const healthz = await fetch(`${base}/healthz`);
    expect(healthz.status).toBe(200);
    expect(await healthz.json()).toEqual({ status: "ok" });
    const readyz = await fetch(`${base}/readyz`);
    expect(readyz.status).toBe(200);
    const boom = await fetch(`${base}/boom`);
    expect(boom.status).toBe(500);
    expect(((await boom.json()) as { code: string }).code).toBe("internal");
    expect(stdout.find((l) => l.event === "process.start")).toMatchObject({
      target: "source",
      shipping: false,
    });
    expect(stdout.filter((l) => l.event === "request").map((l) => l.route)).toEqual([
      "/healthz",
      "/readyz",
      "/boom",
    ]);
    expect(stdout.find((l) => l.event === "error.unexpected")).toMatchObject({ route: "/boom" });
    const health = await service.health.sample();
    expect(health).toMatchObject({
      background: expect.any(Number),
      heapUsedMb: expect.any(Number),
      httpConnections: expect.any(Number),
    });
    // listenConnected is the Postgres LISTEN connection's, written only by the database layer.
    expect(health).not.toHaveProperty("listenConnected");
    const done = service.shutdown.begin("SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    const during = await fetch(`${base}/readyz`).catch(() => undefined);
    if (during !== undefined) expect(during.status).toBe(503);
    await done;
    expect(exits).toEqual([0]);
    expect(stdout.some((l) => l.event === "shutdown.done")).toBe(true);
  }, 30_000);
});

/**
 * A service run as its own process, with the process handlers on. Every request writes a line;
 * what it ships goes to a file; each byte on stdin throws from a timer, uncaught, and the bytes of
 * one write throw in the same turn of the event loop. It ends itself should this process die.
 */
function serviceChild(): { script: string; shipped: string } {
  const dir = mkdtempSync(join(tmpdir(), "fin-stdout-gone-"));
  const script = join(dir, "service.mjs");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { runService } from ${JSON.stringify(new URL("./runtime.ts", import.meta.url).href)};
${exitWithParent(process.pid)}
const shipped = ${JSON.stringify(join(dir, "shipped.jsonl"))};
await runService(
  {
    services: ["api"],
    build: (ctx) => ({
      fetch: () => {
        ctx.telemetry.log("thing.done", {});
        return new Response("ok");
      },
    }),
  },
  {
    host: "127.0.0.1",
    transport: async (body) => {
      for (const line of JSON.parse(gunzipSync(body).toString("utf8"))) {
        appendFileSync(shipped, JSON.stringify(line) + "\\n");
      }
      return 202;
    },
  },
);
process.stdin.on("data", (chunk) => {
  for (let i = 0; i < chunk.length; i++) {
    setTimeout(() => {
      throw new Error("planted");
    }, 0);
  }
});
`,
  );
  return { script, shipped: join(dir, "shipped.jsonl") };
}

function shippedEvents(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => String((JSON.parse(line) as Line).event));
}

describe("runService when stdout's reader goes away", () => {
  it("keeps answering and shipping, then drains and exits 0 within FIN_DRAIN_SECONDS", async () => {
    const { script, shipped } = serviceChild();
    const port = await freePort();
    const run = await spawnThenCloseStdout(
      script,
      baseEnv("api", { FIN_DRAIN_SECONDS: "5", PORT: String(port) }),
    );
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(200);
    }
    run.child.kill("SIGTERM");
    expect(await run.exit(5000)).toBe(0);
    expect(run.stderr()).toBe("");
    const events = shippedEvents(shipped);
    expect(events.filter((event) => event === "thing.done")).toHaveLength(3);
    expect(events).toEqual(
      expect.arrayContaining(["telemetry.stdout_failed", "shutdown.started", "shutdown.done"]),
    );
  }, 30_000);

  it("still exits 1 within the crash flush on an uncaught exception", async () => {
    const { script, shipped } = serviceChild();
    const run = await spawnThenCloseStdout(
      script,
      baseEnv("api", { PORT: String(await freePort()) }),
    );
    run.child.stdin.write("x");
    expect(await run.exit(4000)).toBe(1);
    expect(run.stderr()).toBe("");
    expect(shippedEvents(shipped)).toContain("process.uncaught_exception");
  }, 30_000);

  it("ships the first crash's lines and exits 1 within the flush when more exceptions follow", async () => {
    const { script, shipped } = serviceChild();
    const run = await spawnThenCloseStdout(
      script,
      baseEnv("api", { PORT: String(await freePort()) }),
    );
    run.child.stdin.write("xxx");
    expect(await run.exit(4000)).toBe(1);
    expect(run.stderr()).toBe("");
    const events = shippedEvents(shipped);
    expect(events).toEqual(
      expect.arrayContaining(["process.uncaught_exception", "error.unexpected"]),
    );
    expect(events.filter((event) => event === "process.uncaught_exception")).toHaveLength(1);
  }, 30_000);
});
