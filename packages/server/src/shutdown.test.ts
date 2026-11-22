import { EventEmitter } from "node:events";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { Readiness } from "./health/readiness.ts";
import type { HttpServerHandle } from "./http/serve.ts";
import { Reporter } from "./report.ts";
import {
  type CrashReporter,
  createShutdown,
  onCrash,
  onSignals,
  planShutdown,
} from "./shutdown.ts";
import type { Transport } from "./telemetry/ship.ts";
import { capture, type Line, TEST_RELEASE } from "./testing/capture.ts";

const errorsDsn = (): string =>
  ["https://", "k".repeat(32), "@s1.eu-nbg-2.betterstackdata.com/4242"].join("");

/**
 * Wraps an exit callback so a test can wait for its first call, an event, instead of sleeping and
 * hoping the exit came in time on a loaded machine.
 */
function waitable<A extends unknown[]>(
  record: (...args: A) => void,
): { call: (...args: A) => void; called: Promise<void> } {
  let resolve = () => {};
  const called = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    call: (...args) => {
      record(...args);
      resolve();
    },
    called,
  };
}

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
    const exit = waitable((code: number) => void exits.push(code));
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      server: fakeServer(10_000),
      hooks: [],
      exit: exit.call,
      plan: { preStopMs: 5, inFlightMs: 10_000, forcedAtMs: 60 },
    });
    void shutdown.begin("SIGTERM");
    await exit.called;
    expect(exits).toEqual([1]);
    expect(events("shutdown.forced")[0]).toMatchObject({ phase: "in_flight", level: "error" });
  });

  it("has shipped shutdown.done to Better Stack by the time it exits 0", async () => {
    const { telemetry, reporter, shipped } = capture({ ship: true });
    const atExit: { code: number; shipped: unknown[] }[] = [];
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      server: fakeServer(),
      hooks: [],
      exit: (code) => atExit.push({ code, shipped: shipped.flat().map((l) => l.event) }),
      // A realistic pre-stop: shutdown.started has long been sent when shutdown.done is written.
      plan: { preStopMs: 300, inFlightMs: 50, forcedAtMs: 5000 },
    });
    await shutdown.begin("SIGTERM");
    expect(atExit).toEqual([{ code: 0, shipped: ["shutdown.started", "shutdown.done"] }]);
  });

  it("has shipped shutdown.forced to Better Stack by the time it exits 1", async () => {
    const { telemetry, reporter, shipped } = capture({ ship: true });
    const atExit: { code: number; shipped: unknown[] }[] = [];
    const exit = waitable(
      (code: number) => void atExit.push({ code, shipped: shipped.flat().map((l) => l.event) }),
    );
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      server: fakeServer(10_000),
      hooks: [],
      exit: exit.call,
      plan: { preStopMs: 5, inFlightMs: 10_000, forcedAtMs: 100 },
    });
    void shutdown.begin("SIGTERM");
    await exit.called;
    expect(atExit).toEqual([{ code: 1, shipped: ["shutdown.started", "shutdown.forced"] }]);
  });

  it("listens for SIGTERM and SIGINT", async () => {
    const { telemetry, reporter } = capture();
    const target = new EventEmitter();
    const exits: number[] = [];
    const exit = waitable((code: number) => void exits.push(code));
    const shutdown = createShutdown({
      drainSeconds: 40,
      telemetry,
      reporter,
      readiness: new Readiness(),
      hooks: [],
      exit: exit.call,
      plan: { preStopMs: 1, inFlightMs: 1, forcedAtMs: 1000 },
    });
    onSignals(shutdown, target);
    target.emit("SIGINT");
    await exit.called;
    expect(shutdown.started).toBe(true);
    expect(exits).toEqual([0]);
  });
});

describe("onCrash", () => {
  it("logs and reports an uncaught exception, then exits 1; an unhandled rejection is logged", async () => {
    const { telemetry, reporter, events } = capture();
    const target = new EventEmitter();
    const exits: number[] = [];
    const exit = waitable((code: number) => void exits.push(code));
    onCrash({ telemetry, reporter, exit: exit.call }, target);
    target.emit("unhandledRejection", new Error("someone@example.com"));
    target.emit("uncaughtException", new RangeError("boom"));
    await exit.called;
    expect(events("process.unhandled_rejection")).toHaveLength(1);
    expect(events("process.uncaught_exception")[0]).toMatchObject({ errorName: "RangeError" });
    expect(events("error.unexpected")).toHaveLength(2);
    expect(JSON.stringify(events("process.unhandled_rejection"))).not.toContain("example.com");
    expect(exits).toEqual([1]);
  });

  it("ships the first crash's line and Errors event when more exceptions follow, and exits once", async () => {
    // Two requests that hit one bug throw a few milliseconds apart, while the first crash's line
    // and event are still on their way (each send here takes 150 ms).
    const shipped: string[] = [];
    const transport: Transport = async (body) => {
      await new Promise((r) => setTimeout(r, 150));
      for (const line of JSON.parse(gunzipSync(body).toString("utf8")) as Line[]) {
        shipped.push(String(line.event));
      }
      return 202;
    };
    const { telemetry } = capture({ transport });
    const envelopes: string[] = [];
    const reporter = new Reporter({
      dsn: errorsDsn(),
      release: TEST_RELEASE,
      environment: "ci",
      service: "api",
      telemetry,
      fetch: (async (_url: string, init: RequestInit) => {
        await new Promise((r) => setTimeout(r, 150));
        envelopes.push(String(init.body));
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    const target = new EventEmitter();
    const atExit: { code: number; shipped: string[]; envelopes: number; ms: number }[] = [];
    const t0 = performance.now();
    const exit = waitable(
      (code: number) =>
        void atExit.push({
          code,
          shipped: [...shipped],
          envelopes: envelopes.length,
          ms: performance.now() - t0,
        }),
    );
    onCrash({ telemetry, reporter, exit: exit.call }, target);
    target.emit("uncaughtException", new RangeError("first"));
    target.emit("uncaughtException", new TypeError("second"));
    await new Promise((r) => setTimeout(r, 5));
    target.emit("uncaughtException", new TypeError("third"));
    expect(atExit).toEqual([]);
    await exit.called;
    await new Promise((r) => setTimeout(r, 100));
    expect(atExit).toHaveLength(1);
    const [end] = atExit;
    expect(end?.code).toBe(1);
    expect(end?.shipped).toEqual(
      expect.arrayContaining(["process.uncaught_exception", "error.unexpected"]),
    );
    expect(end?.shipped.filter((event) => event === "process.uncaught_exception")).toHaveLength(1);
    expect(end?.envelopes).toBe(1);
    expect(end?.ms).toBeLessThan(2000);
  });

  it("exits 1 at the crash deadline when the flush never settles", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const { telemetry } = capture();
      const target = new EventEmitter();
      const exits: number[] = [];
      const reporter: CrashReporter = {
        reportError: () => "",
        flush: () => new Promise<boolean>(() => undefined),
      };
      onCrash({ telemetry, reporter, exit: (code) => exits.push(code) }, target);
      target.emit("uncaughtException", new Error("first"));
      target.emit("uncaughtException", new Error("second"));
      await vi.advanceTimersByTimeAsync(2499);
      expect(exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(exits).toEqual([1]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(exits).toEqual([1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exits 1 at once when exceptions keep coming with no turn of the event loop between them", () => {
    // A callback that throws and queues itself again as a microtask or a tick never lets a timer
    // run, the flush's deadline among them.
    const { telemetry, reporter } = capture();
    const target = new EventEmitter();
    const exits: number[] = [];
    onCrash({ telemetry, reporter, exit: (code) => exits.push(code) }, target);
    target.emit("uncaughtException", new Error("first"));
    for (let i = 0; i < 999; i++) target.emit("uncaughtException", new Error("again"));
    expect(exits).toEqual([]);
    target.emit("uncaughtException", new Error("again"));
    expect(exits).toEqual([1]);
    target.emit("uncaughtException", new Error("again"));
    expect(exits).toEqual([1]);
  });

  it("works with no error reporter, and the shipped line says where the process failed", async () => {
    const { telemetry, shipped } = capture({ ship: true });
    const target = new EventEmitter();
    const atExit: unknown[][] = [];
    const exit = waitable(() => void atExit.push(shipped.flat()));
    onCrash({ telemetry, exit: exit.call }, target);
    target.emit("uncaughtException", new RangeError("boom"));
    await exit.called;
    expect(atExit).toHaveLength(1);
    expect(atExit[0]?.[0]).toMatchObject({
      event: "process.uncaught_exception",
      errorName: "RangeError",
      frames: expect.arrayContaining([expect.objectContaining({ line: expect.any(Number) })]),
    });
  });
});
