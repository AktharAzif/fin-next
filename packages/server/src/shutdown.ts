// Graceful shutdown (ARCHITECTURE §3.5; spec 08 §7.3). On SIGTERM: `shutdown.started`, readiness
// off, a pre-stop window answering with `Connection: close`, then the server closes and in-flight
// requests finish, the stop hooks run (the scheduler lease, the pool), background work drains, the
// error client and telemetry flush, `shutdown.done`, exit 0. Everything fits inside
// FIN_DRAIN_SECONDS, Railway's draining time for the service; if it does not, `shutdown.forced`
// and exit 1, still before Railway's kill.
import { safeError } from "@fin/core";
import type { Readiness } from "./health/readiness.ts";
import type { HttpServerHandle } from "./http/serve.ts";
import type { Reporter } from "./report.ts";
import type { Telemetry } from "./telemetry/telemetry.ts";

export interface ShutdownPlan {
  preStopMs: number;
  inFlightMs: number;
  forcedAtMs: number;
}

/**
 * Splits the drain: a pre-stop of at most 10 s (a quarter of the drain when shorter), in-flight
 * requests up to 30 s, and the forced exit one second before the drain ends.
 */
export function planShutdown(drainSeconds: number): ShutdownPlan {
  const drainMs = drainSeconds * 1000;
  const forcedAtMs = Math.max(1000, drainMs - 1000);
  const preStopMs = Math.min(10_000, Math.floor(drainMs / 4));
  const inFlightMs = Math.max(0, Math.min(30_000, forcedAtMs - preStopMs - 3000));
  return { preStopMs, inFlightMs, forcedAtMs };
}

export interface StopHook {
  name: string;
  run: () => Promise<void> | void;
}

export interface ShutdownOptions {
  drainSeconds: number;
  telemetry: Telemetry;
  reporter: Reporter;
  readiness: Readiness;
  server?: HttpServerHandle;
  hooks: StopHook[];
  exit: (code: number) => void;
  plan?: ShutdownPlan;
}

export interface Shutdown {
  begin(signal: string): Promise<void>;
  readonly started: boolean;
}

export function createShutdown(options: ShutdownOptions): Shutdown {
  const plan = options.plan ?? planShutdown(options.drainSeconds);
  let started = false;
  let exited = false;
  const exit = (code: number): void => {
    if (exited) return;
    exited = true;
    options.exit(code);
  };

  const begin = async (signal: string): Promise<void> => {
    if (started) return;
    started = true;
    const t0 = performance.now();
    const elapsed = (): number => performance.now() - t0;
    const remaining = (): number => Math.max(0, plan.forcedAtMs - elapsed());
    options.telemetry.logUnit("shutdown.started", {
      signal,
      drainSeconds: options.drainSeconds,
      preStopMs: plan.preStopMs,
    });
    options.readiness.markStopping();
    options.server?.startDraining();

    let phase = "pre_stop";
    const forced = setTimeout(() => {
      options.telemetry.logUnit("shutdown.forced", { phase }, "error");
      void Promise.allSettled([options.telemetry.flush(500), options.reporter.flush(500)]).finally(
        () => exit(1),
      );
    }, plan.forcedAtMs);

    await new Promise((resolve) => setTimeout(resolve, plan.preStopMs));
    phase = "in_flight";
    const closed =
      options.server !== undefined
        ? await options.server.close(plan.inFlightMs)
        : { forced: false };
    phase = "hooks";
    for (const hook of options.hooks) {
      try {
        await hook.run();
      } catch (error) {
        const safe = safeError(error);
        options.telemetry.log(
          "background.failed",
          { task: `shutdown.${hook.name}`, errorName: safe.errorName, errorCode: safe.errorCode },
          "error",
        );
      }
    }
    phase = "flush";
    await options.reporter.flush(Math.min(2000, remaining()));
    options.telemetry.logUnit("shutdown.done", {
      durationMs: Math.round(elapsed()),
      requestsCut: closed.forced,
    });
    await options.telemetry.flush(remaining());
    clearTimeout(forced);
    exit(0);
  };

  return {
    begin,
    get started() {
      return started;
    },
  };
}

/** Listens for SIGTERM and SIGINT; a second signal is ignored while the first drains. */
export function onSignals(shutdown: Shutdown, target: NodeJS.EventEmitter = process): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    target.on(signal, () => void shutdown.begin(signal));
  }
}

/**
 * Crash handlers (ARCHITECTURE §3.5, §10.3): an uncaught exception is logged, reported and flushed
 * for at most 2 seconds, then the process exits 1; an unhandled rejection is logged and reported,
 * never silent.
 */
export function onCrash(
  options: { telemetry: Telemetry; reporter: Reporter; exit: (code: number) => void },
  target: NodeJS.EventEmitter = process,
): void {
  target.on("uncaughtException", (error: unknown) => {
    const safe = safeError(error);
    options.telemetry.logUnit(
      "process.uncaught_exception",
      { errorName: safe.errorName, errorCode: safe.errorCode },
      "error",
    );
    options.reporter.reportError(error, { job: "process" });
    void Promise.allSettled([options.telemetry.flush(2000), options.reporter.flush(2000)]).finally(
      () => options.exit(1),
    );
  });
  target.on("unhandledRejection", (reason: unknown) => {
    const safe = safeError(reason);
    options.telemetry.logUnit(
      "process.unhandled_rejection",
      { errorName: safe.errorName, errorCode: safe.errorCode },
      "error",
    );
    options.reporter.reportError(reason, { job: "process" });
  });
}
