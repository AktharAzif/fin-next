// spec 01 §7.3's state machine and AC-P0-35's unit half.
import { capture } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { type ChildHandle, type ProbeResult, Supervisor } from "./supervisor.ts";

function fakeChild() {
  const listeners: ((code: number | null, signal: NodeJS.Signals | null) => void)[] = [];
  const signals: string[] = [];
  const child: ChildHandle = {
    kill: (signal) => {
      signals.push(signal);
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        setTimeout(() => {
          for (const l of listeners) l(signal === "SIGTERM" ? 0 : null, signal);
        }, 1);
      }
    },
    onExit: (listener) => listeners.push(listener),
  };
  return {
    child,
    signals,
    die: (code: number) => {
      for (const l of listeners) l(code, null);
    },
  };
}

function setup(probes: (ProbeResult | "throw")[]) {
  const captured = capture({ service: "cloudflared-public" });
  const { child, signals, die } = fakeChild();
  const exits: number[] = [];
  let i = 0;
  const supervisor = new Supervisor({
    telemetry: captured.telemetry,
    spawnChild: () => child,
    probe: async () => {
      const next = probes[Math.min(i++, probes.length - 1)];
      if (next === "throw" || next === undefined) throw new Error("ECONNREFUSED");
      return next;
    },
    version: "2026.11.1",
    exit: (code) => exits.push(code),
    drainMs: 5000,
    pollMs: 1_000_000,
    healthMs: 1_000_000,
    killGraceMs: 50,
  });
  const states = () => captured.events("connector.state").map((l) => l.to);
  return { supervisor, captured, signals, die, exits, states };
}

const OK: ProbeResult = { ok: true, connections: 4 };
const DOWN: ProbeResult = { ok: false, connections: 0 };

describe("Supervisor", () => {
  it("moves connecting -> ready, and /readyz is true only in ready", async () => {
    const { supervisor, states } = setup([DOWN, OK]);
    expect(supervisor.state).toBe("starting");
    supervisor.start();
    expect(supervisor.state).toBe("connecting");
    expect(supervisor.ready).toBe(false);
    await supervisor.poll();
    expect(supervisor.state).toBe("connecting");
    await supervisor.poll();
    expect(supervisor.ready).toBe(true);
    expect(states()).toEqual(["connecting", "ready"]);
  });

  it("degrades after 3 failed polls, recovers, and counts the recovery as a restart", async () => {
    const { supervisor, captured, states } = setup([OK, DOWN, DOWN, DOWN, OK]);
    supervisor.start();
    for (let i = 0; i < 5; i++) await supervisor.poll();
    expect(states()).toEqual(["connecting", "ready", "degraded", "ready"]);
    supervisor.writeHealth();
    expect(captured.events("connector.health")[0]).toMatchObject({
      connections: 4,
      restarts: 1,
      version: "2026.11.1",
      state: "ready",
    });
  });

  it("exits 1 after 12 failed polls in a row, stopping cloudflared first", async () => {
    const { supervisor, captured, signals, exits, states } = setup(["throw"]);
    supervisor.start();
    for (let i = 0; i < 12; i++) await supervisor.poll();
    expect(states()).toEqual(["connecting", "degraded", "exiting"]);
    expect(signals[0]).toBe("SIGTERM");
    expect(exits).toEqual([1]);
    expect(captured.events("connector.exited")[0]).toMatchObject({
      reason: "not_ready",
      exitCode: 1,
      level: "error",
    });
  });

  it("exits 1 when cloudflared exits on its own", async () => {
    const { supervisor, die, exits, captured } = setup([OK]);
    supervisor.start();
    await supervisor.poll();
    die(2);
    await new Promise((r) => setTimeout(r, 20));
    expect(supervisor.state).toBe("exiting");
    expect(exits).toEqual([1]);
    expect(captured.events("connector.exited")[0]).toMatchObject({
      reason: "cloudflared_exited",
      cloudflaredCode: 2,
    });
  });

  it("forwards SIGTERM and exits 0", async () => {
    const { supervisor, signals, exits, captured } = setup([OK]);
    supervisor.start();
    await supervisor.poll();
    await supervisor.stop();
    expect(signals).toEqual(["SIGTERM"]);
    expect(exits).toEqual([0]);
    expect(captured.events("connector.exited")[0]).toMatchObject({
      reason: "sigterm",
      exitCode: 0,
    });
    await supervisor.poll();
    expect(exits).toEqual([0]);
  });
});
