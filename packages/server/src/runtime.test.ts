import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { privateHealth } from "./health/readiness.ts";
import type { FinEnv } from "./http/context.ts";
import { errorHandler, notFoundHandler, requestUnit } from "./http/request.ts";
import { runService, type ServiceDefinition } from "./runtime.ts";
import { baseEnv, type Line } from "./testing/capture.ts";

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
    });
    const done = service.shutdown.begin("SIGTERM");
    await new Promise((r) => setTimeout(r, 20));
    const during = await fetch(`${base}/readyz`).catch(() => undefined);
    if (during !== undefined) expect(during.status).toBe(503);
    await done;
    expect(exits).toEqual([0]);
    expect(stdout.some((l) => l.event === "shutdown.done")).toBe(true);
  }, 30_000);
});
