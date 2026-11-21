import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { Readiness } from "./health/readiness.ts";
import type { HttpServerHandle } from "./http/serve.ts";
import { createShutdown, onCrash, onSignals, planShutdown } from "./shutdown.ts";
import { capture } from "./testing/capture.ts";

describe("planShutdown", () => {
  it("fits every phase inside FIN_DRAIN_SECONDS", () => {
    for (const drain of [5, 15, 35, 40, 60, 600]) {
      const plan = planShutdown(drain);
      expect(plan.forcedAtMs).toBeLessThan(drain * 1000);
      expect(plan.preStopMs + plan.inFlightMs).toBeLessThan(plan.forcedAtMs);
      expect(plan.preStopMs).toBeLessThanOrEqual(10_000);
      expect(plan.inFlightMs).toBeLessThanOrEqual(30_000);
    }
    expect(planShutdown(40)).toEqual({ preStopMs: 10_000, inFlightMs: 26_000, forcedAtMs: 39_000 });
  });
});

function fakeServer(closeDelayMs = 0): HttpServerHandle & { events: string[] } {
  const events: string[] = [];
  let draining = false;
  return {
    events,
    server: undefined as never,
    port: 0,
    startDraining: () => {
      draining = true;
      events.push("draining");
    },
    get draining() {
      return draining;
    },
    close: async (graceMs) => {
      events.push(`close:${graceMs}`);
      await new Promise((r) => setTimeout(r, closeDelayMs));
      return { forced: false };
    },
    connections: async () => 0,
  };
}

describe("createShutdown", () => {
  it("runs the phases in order and exits 0 with shutdown.started and shutdown.done", async () => {
    const { telemetry, reporter, events } = capture();
    const readiness = new Readiness();
    const server = fakeServer();
    const order: string[] = [];
    const exits: number[] = [];
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness,
      server,
      hooks: [
        { name: "lease", run: () => void order.push("lease") },
        { name: "pool", run: async () => void order.push("pool") },
        { name: "broken", run: () => Promise.reject(new Error("x")) },
      ],
      exit: (code) => exits.push(code),
      plan: { preStopMs: 10, inFlightMs: 50, forcedAtMs: 2000 },
    });
    await shutdown.begin("SIGTERM");
    await shutdown.begin("SIGTERM");
    expect(server.events).toEqual(["draining", "close:50"]);
    expect(order).toEqual(["lease", "pool"]);
    expect(readiness.isStopping).toBe(true);
    expect((await readiness.evaluate()).failing).toEqual(["shutting_down"]);
    expect(exits).toEqual([0]);
    expect(events("shutdown.started")[0]).toMatchObject({ signal: "SIGTERM", drainSeconds: 40 });
    expect(events("shutdown.done")).toHaveLength(1);
    expect(events("background.failed")[0]).toMatchObject({ task: "shutdown.broken" });
  });

  it("forces the exit before the drain ends when a phase hangs", async () => {
    const { telemetry, reporter, events } = capture();
    const exits: number[] = [];
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      server: fakeServer(10_000),
      hooks: [],
      exit: (code) => exits.push(code),
      plan: { preStopMs: 5, inFlightMs: 10_000, forcedAtMs: 60 },
    });
    void shutdown.begin("SIGTERM");
    await new Promise((r) => setTimeout(r, 700));
    expect(exits).toEqual([1]);
    expect(events("shutdown.forced")[0]).toMatchObject({ phase: "in_flight", level: "error" });
  });

  it("listens for SIGTERM and SIGINT", async () => {
    const { telemetry, reporter } = capture();
    const target = new EventEmitter();
    const exits: number[] = [];
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      hooks: [],
      exit: (code) => exits.push(code),
      plan: { preStopMs: 1, inFlightMs: 1, forcedAtMs: 1000 },
    });
    onSignals(shutdown, target);
    target.emit("SIGINT");
    await new Promise((r) => setTimeout(r, 50));
    expect(shutdown.started).toBe(true);
    expect(exits).toEqual([0]);
  });
});

describe("onCrash", () => {
  it("logs and reports an uncaught exception, then exits 1; an unhandled rejection is logged", async () => {
    const { telemetry, reporter, events } = capture();
    const target = new EventEmitter();
    const exits: number[] = [];
    onCrash({ telemetry, reporter, exit: (code) => exits.push(code) }, target);
    target.emit("unhandledRejection", new Error("someone@example.com"));
    target.emit("uncaughtException", new RangeError("boom"));
    await new Promise((r) => setTimeout(r, 50));
    expect(events("process.unhandled_rejection")).toHaveLength(1);
    expect(events("process.uncaught_exception")[0]).toMatchObject({ errorName: "RangeError" });
    expect(events("error.unexpected")).toHaveLength(2);
    expect(JSON.stringify(events("process.unhandled_rejection"))).not.toContain("example.com");
    expect(exits).toEqual([1]);
  });
});
