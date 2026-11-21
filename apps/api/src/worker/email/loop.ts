// The worker's email loop (ARCHITECTURE §9.4): `NOTIFY email_outbox` wakes it, a 5-second poll is the
// backstop. Each tick drains the outbox while claims come back full, sends due digests, and writes one
// `job.run` line (`job: "email-send"`) with `oldestDueS`, which `email-outbox-age` watches. The
// delivery check runs at start and then on its own timer. A tick never throws: a failure is a
// `job.run` with `result: "failed"`, and the next tick tries again.
import type { BatchResult, EmailLog } from "@fin/email";

export const JOB = "email-send";

export interface SenderLike {
  runOnce(): Promise<BatchResult>;
  flushDigests(): Promise<number>;
  age(): Promise<{ urgentS: number; otherS: number; waiting: number }>;
  sweep(): Promise<void>;
}

export type Cancel = () => void;
export type Scheduler = (run: () => void, everyMs: number) => Cancel;

/** Starts a repeating timer that does not keep the process alive. Called only from `start()`. */
export const intervalScheduler: Scheduler = (run, everyMs) => {
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** Subscribes to wake-ups; resolves to an unsubscribe. */
export type Listen = (wake: () => void) => Promise<() => Promise<void>>;

export interface EmailLoopOptions {
  readonly sender: SenderLike;
  readonly log: EmailLog;
  readonly clock: { now(): number };
  readonly listen?: Listen;
  readonly deliveryCheck?: () => Promise<unknown>;
  readonly schedule?: Scheduler;
  readonly pollMs?: number;
  readonly deliveryCheckEveryMs?: number;
  /** Claims per tick before yielding, so one tick cannot run forever. */
  readonly maxRunsPerTick?: number;
  /** An idle tick still writes its line at least this often, so the age reading never goes quiet. */
  readonly idleLineMs?: number;
  readonly sweepEveryMs?: number;
}

type Trigger = "start" | "notify" | "poll";

export class EmailLoop {
  private readonly o: EmailLoopOptions;
  private running: Promise<void> | undefined;
  private again: Trigger | undefined;
  private cancels: Cancel[] = [];
  private unlisten: (() => Promise<void>) | undefined;
  private lastLineAt = Number.NEGATIVE_INFINITY;
  private lastSweepAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(options: EmailLoopOptions) {
    this.o = options;
  }

  async start(): Promise<void> {
    const schedule = this.o.schedule ?? intervalScheduler;
    this.stopped = false;
    if (this.o.listen !== undefined) {
      try {
        this.unlisten = await this.o.listen(() => this.wake("notify"));
      } catch {
        // The poll is the backstop: mail still goes, up to 5 seconds later.
        this.unlisten = undefined;
        this.o.log.log("background.failed", { name: "email-listen", reason: "connect" }, "warn");
      }
    }
    this.cancels.push(schedule(() => this.wake("poll"), this.o.pollMs ?? 5000));
    const check = this.o.deliveryCheck;
    if (check !== undefined) {
      void check().catch(() => undefined);
      this.cancels.push(
        schedule(
          () => void check().catch(() => undefined),
          this.o.deliveryCheckEveryMs ?? 15 * 60_000,
        ),
      );
    }
    this.wake("start");
  }

  /** Asks for a tick; one runs at a time, and a wake during a tick runs one more after it. */
  wake(trigger: Trigger): void {
    if (this.stopped) return;
    if (this.running !== undefined) {
      this.again = trigger;
      return;
    }
    this.running = this.tick(trigger).finally(() => {
      this.running = undefined;
      const next = this.again;
      this.again = undefined;
      if (next !== undefined) this.wake(next);
    });
  }

  /** Waits for the tick in flight, if any (tests and shutdown). */
  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
    await this.unlisten?.().catch(() => undefined);
    this.unlisten = undefined;
    await this.idle();
  }

  async tick(trigger: Trigger): Promise<void> {
    const started = this.o.clock.now();
    const total = { claimed: 0, sent: 0, failed: 0, folded: 0, deferred: 0 };
    const add = (r: BatchResult): void => {
      total.claimed += r.claimed;
      total.sent += r.sent;
      total.failed += r.failed;
      total.folded += r.folded;
      total.deferred += r.deferred;
    };
    try {
      const max = this.o.maxRunsPerTick ?? 20;
      let runs = 0;
      for (; runs < max; runs++) {
        const r = await this.o.sender.runOnce();
        add(r);
        if (!r.full) break;
      }
      const digests = await this.o.sender.flushDigests();
      if (digests > 0) add(await this.o.sender.runOnce());
      if (started - this.lastSweepAt >= (this.o.sweepEveryMs ?? 3_600_000)) {
        await this.o.sender.sweep();
        this.lastSweepAt = started;
      }
      const age = await this.o.sender.age();
      const busy = total.claimed > 0 || digests > 0;
      if (busy || started - this.lastLineAt >= (this.o.idleLineMs ?? 60_000)) {
        this.lastLineAt = started;
        this.o.log.log("job.run", {
          job: JOB,
          trigger,
          result: busy ? "ok" : "skipped",
          ...(busy ? {} : { skipReason: "no_work" }),
          durationMs: this.o.clock.now() - started,
          processed: total.sent,
          failed: total.failed,
          folded: total.folded,
          deferred: total.deferred,
          digests,
          oldestDueS: age.urgentS,
          oldestOtherS: age.otherS,
          waiting: age.waiting,
          ...(runs >= max ? { capped: true } : {}),
        });
      }
    } catch (error) {
      this.lastLineAt = started;
      const code = (error as { code?: unknown }).code;
      this.o.log.log(
        "job.run",
        {
          job: JOB,
          trigger,
          result: "failed",
          code:
            typeof code === "string" ? `pg_${code}` : error instanceof Error ? error.name : "error",
          durationMs: this.o.clock.now() - started,
          processed: total.sent,
          failed: total.failed,
        },
        "error",
      );
    }
  }
}
