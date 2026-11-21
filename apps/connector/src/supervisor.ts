// The connector supervisor's state machine (spec 01 §7.3; ARCHITECTURE §5.4; AC-P0-35). It starts
// cloudflared, polls its loopback `/ready` every 5 seconds, answers `/readyz` 200 only in `ready`,
// and exits so Railway's restart policy replaces a connector that is stuck or dead:
//
//   starting   -> the process renders and validates the configuration       /readyz 503
//   connecting -> cloudflared runs; /ready is not yet 200                    /readyz 503
//   ready      -> /ready answers 200                                         /readyz 200
//   degraded   -> /ready failed 3 polls in a row                             /readyz 503
//   exiting    -> 12 failed polls in a row (60 s), cloudflared exited, or SIGTERM
//
// `connector.state` marks every move, `connector.health` goes out every minute (connections,
// restarts, version, state), and `connector.exited` (code, reason) is the last line before exit.
// `restarts` counts recoveries from `degraded` back to `ready`: the supervisor never restarts
// cloudflared itself; when it gives up, the whole container exits and Railway restarts it.
import type { Telemetry } from "@fin/server/telemetry";

export type ConnectorState = "starting" | "connecting" | "ready" | "degraded" | "exiting";

export type ExitReason = "cloudflared_exited" | "not_ready" | "sigterm" | "spawn_failed";

export interface ChildHandle {
  kill(signal: NodeJS.Signals): void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  /** cloudflared could not be started (Node reports a missing binary as an event, not a throw). */
  onSpawnError(listener: () => void): void;
}

export interface ProbeResult {
  ok: boolean;
  connections: number;
}

export interface SupervisorOptions {
  telemetry: Telemetry;
  spawnChild: () => ChildHandle;
  probe: () => Promise<ProbeResult>;
  version: string;
  exit: (code: number) => void;
  /** FIN_DRAIN_SECONDS in ms: how long SIGTERM waits for cloudflared before exiting anyway. */
  drainMs: number;
  pollMs?: number;
  healthMs?: number;
  degradedAfter?: number;
  exitAfter?: number;
  /** How long a give-up waits for cloudflared to stop before exiting anyway. */
  killGraceMs?: number;
}

export const POLL_MS = 5000;
export const HEALTH_MS = 60_000;
export const DEGRADED_AFTER = 3;
export const EXIT_AFTER = 12;

export class Supervisor {
  private current: ConnectorState = "starting";
  private failures = 0;
  private restarts = 0;
  private connections = 0;
  private child: ChildHandle | undefined;
  private childExited = false;
  private childCode: number | null = null;
  private exitWaiters: (() => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private polling = false;
  private finished = false;
  private readonly options: Required<
    Omit<SupervisorOptions, "telemetry" | "spawnChild" | "probe" | "exit">
  > &
    SupervisorOptions;

  constructor(options: SupervisorOptions) {
    this.options = {
      pollMs: POLL_MS,
      healthMs: HEALTH_MS,
      degradedAfter: DEGRADED_AFTER,
      exitAfter: EXIT_AFTER,
      killGraceMs: 5000,
      ...options,
    };
  }

  get state(): ConnectorState {
    return this.current;
  }

  get ready(): boolean {
    return this.current === "ready";
  }

  private move(next: ConnectorState, reason?: string): void {
    if (next === this.current) return;
    const from = this.current;
    this.current = next;
    this.options.telemetry.logUnit(
      "connector.state",
      { from, to: next, ...(reason !== undefined ? { reason } : {}) },
      next === "degraded" || next === "exiting" ? "warn" : "info",
    );
  }

  /** Starts cloudflared and the poll and health timers. */
  start(): void {
    const spawnFailed = (): void => {
      if (this.current === "exiting") return;
      this.move("exiting", "spawn_failed");
      void this.finish(1, "spawn_failed");
    };
    try {
      this.child = this.options.spawnChild();
    } catch {
      spawnFailed();
      return;
    }
    this.child.onSpawnError(spawnFailed);
    this.child.onExit((code) => {
      this.childExited = true;
      this.childCode = code;
      for (const waiter of this.exitWaiters.splice(0)) waiter();
      if (this.current !== "exiting") {
        this.move("exiting", "cloudflared_exited");
        void this.finish(1, "cloudflared_exited");
      }
    });
    this.move("connecting");
    this.pollTimer = setInterval(() => void this.poll(), this.options.pollMs);
    this.healthTimer = setInterval(() => this.writeHealth(), this.options.healthMs);
  }

  /** One poll of cloudflared's /ready. */
  async poll(): Promise<void> {
    if (this.polling || this.current === "exiting") return;
    this.polling = true;
    try {
      let result: ProbeResult;
      try {
        result = await this.options.probe();
      } catch {
        result = { ok: false, connections: 0 };
      }
      // The state may have moved while the probe was in flight.
      if ((this.current as ConnectorState) === "exiting") return;
      this.connections = result.connections;
      if (result.ok) {
        if (this.current === "degraded") this.restarts++;
        this.failures = 0;
        this.move("ready");
        return;
      }
      this.failures++;
      if (this.failures >= this.options.exitAfter) {
        this.move("exiting", "not_ready");
        await this.stopChild(this.options.killGraceMs);
        await this.finish(1, "not_ready");
      } else if (this.failures >= this.options.degradedAfter) {
        this.move("degraded");
      }
    } finally {
      this.polling = false;
    }
  }

  writeHealth(): void {
    this.options.telemetry.logUnit("connector.health", {
      connections: this.connections,
      restarts: this.restarts,
      version: this.options.version,
      state: this.current,
    });
  }

  /** SIGTERM: forward it to cloudflared, wait for it within the drain, then exit 0. */
  async stop(): Promise<void> {
    if (this.current === "exiting") return;
    this.move("exiting", "sigterm");
    await this.stopChild(Math.max(0, this.options.drainMs - 3000));
    await this.finish(0, "sigterm");
  }

  private stopChild(graceMs: number): Promise<void> {
    if (this.child === undefined || this.childExited) return Promise.resolve();
    const child = this.child;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, graceMs);
      this.exitWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  private async finish(code: number, reason: ExitReason): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    if (this.healthTimer !== undefined) clearInterval(this.healthTimer);
    this.options.telemetry.logUnit(
      "connector.exited",
      // `code` is a withheld field name (spec 08 §5.4), so the codes are named for what they are.
      { cloudflaredCode: this.childCode, reason, exitCode: code },
      code === 0 ? "info" : "error",
    );
    await this.options.telemetry.flush(2000);
    this.options.exit(code);
  }
}
