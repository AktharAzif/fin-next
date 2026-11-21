import type { BatchResult } from "@fin/email";
import { LineRecorder } from "@fin/email/testing";
import { describe, expect, it } from "vitest";
import { onDeliveryCheckSent, pingHeartbeat } from "./delivery-check.ts";
import { type ListenClient, pgListen } from "./listen.ts";
import { EmailLoop, type Scheduler, type SenderLike } from "./loop.ts";

const EMPTY: BatchResult = { claimed: 0, sent: 0, failed: 0, folded: 0, deferred: 0, full: false };

class FakeSender implements SenderLike {
  batches: BatchResult[] = [];
  runs = 0;
  digests = 0;
  sweeps = 0;
  fail = false;
  async runOnce(): Promise<BatchResult> {
    this.runs += 1;
    if (this.fail) throw Object.assign(new Error("db down"), { code: "57P01" });
    return this.batches.shift() ?? EMPTY;
  }
  async flushDigests(): Promise<number> {
    const n = this.digests;
    this.digests = 0;
    return n;
  }
  async age() {
    return { urgentS: 7, otherS: 30, waiting: 2 };
  }
  async sweep(): Promise<void> {
    this.sweeps += 1;
  }
}

function manualScheduler() {
  const timers: { run: () => void; everyMs: number; cancelled: boolean }[] = [];
  const schedule: Scheduler = (run, everyMs) => {
    const t = { run, everyMs, cancelled: false };
    timers.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  return { schedule, timers };
}

function setup(sender = new FakeSender()) {
  let now = 1_000_000;
  const log = new LineRecorder();
  const { schedule, timers } = manualScheduler();
  let checks = 0;
  const loop = new EmailLoop({
    sender,
    log,
    clock: { now: () => now },
    schedule,
    deliveryCheck: async () => {
      checks += 1;
    },
  });
  return { loop, sender, log, timers, advance: (ms: number) => (now += ms), checks: () => checks };
}

describe("EmailLoop", () => {
  it("drains while claims come back full, and writes one job.run with the age reading", async () => {
    const h = setup();
    h.sender.batches = [
      { ...EMPTY, claimed: 4, sent: 4, full: true },
      { ...EMPTY, claimed: 2, sent: 1, failed: 1, full: false },
    ];
    await h.loop.start();
    await h.loop.idle();
    expect(h.sender.runs).toBe(2);
    const lines = h.log.named("job.run");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields).toMatchObject({
      job: "email-send",
      trigger: "start",
      result: "ok",
      processed: 5,
      failed: 1,
      oldestDueS: 7,
      oldestOtherS: 30,
      waiting: 2,
    });
    expect(h.checks()).toBe(1);
    expect(h.timers.map((t) => t.everyMs)).toEqual([5000, 900_000]);
    await h.loop.stop();
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
  });

  it("runs on the poll alone when the listener cannot connect, and says so", async () => {
    const log = new LineRecorder();
    const { schedule } = manualScheduler();
    const loop = new EmailLoop({
      sender: new FakeSender(),
      log,
      clock: { now: () => 0 },
      schedule,
      listen: async () => {
        throw new Error("refused");
      },
    });
    await loop.start();
    await loop.idle();
    expect(log.named("background.failed")[0]?.fields).toMatchObject({
      name: "email-listen",
      reason: "connect",
    });
    expect(log.named("job.run")).toHaveLength(1);
    await loop.stop();
  });

  it("writes an idle line at most once a minute", async () => {
    const h = setup();
    await h.loop.tick("poll");
    await h.loop.tick("poll");
    h.advance(60_000);
    await h.loop.tick("poll");
    const lines = h.log.named("job.run");
    expect(lines).toHaveLength(2);
    expect(lines[0]?.fields).toMatchObject({ result: "skipped", skipReason: "no_work" });
  });

  it("sends due digests in the same tick, and sweeps once an hour", async () => {
    const h = setup();
    h.sender.digests = 1;
    await h.loop.tick("poll");
    expect(h.sender.runs).toBe(2);
    expect(h.log.named("job.run")[0]?.fields).toMatchObject({ digests: 1, result: "ok" });
    await h.loop.tick("poll");
    expect(h.sender.sweeps).toBe(1);
    h.advance(3_600_000);
    await h.loop.tick("poll");
    expect(h.sender.sweeps).toBe(2);
  });

  it("caps one tick's claims", async () => {
    const h = setup();
    h.sender.batches = Array.from({ length: 30 }, () => ({
      ...EMPTY,
      claimed: 4,
      sent: 4,
      full: true,
    }));
    await h.loop.tick("notify");
    expect(h.sender.runs).toBe(20);
    expect(h.log.named("job.run")[0]?.fields).toMatchObject({ capped: true, processed: 80 });
  });

  it("never throws: a failing tick is a failed job.run with a code", async () => {
    const h = setup();
    h.sender.fail = true;
    await expect(h.loop.tick("poll")).resolves.toBeUndefined();
    expect(h.log.named("job.run")[0]).toMatchObject({
      level: "error",
      fields: { result: "failed", code: "pg_57P01" },
    });
  });

  it("runs one tick at a time and one more after a wake during it", async () => {
    const h = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = h.sender.runOnce.bind(h.sender);
    h.sender.runOnce = async () => {
      if (h.sender.runs === 0) await gate;
      return slow();
    };
    h.loop.wake("poll");
    h.loop.wake("notify");
    h.loop.wake("notify");
    release();
    await h.loop.idle();
    expect(h.sender.runs).toBe(2);
  });
});

class FakeClient implements ListenClient {
  static made: FakeClient[] = [];
  handlers = new Map<string, ((arg: never) => void)[]>();
  queries: string[] = [];
  ended = false;
  failConnect = false;
  constructor() {
    FakeClient.made.push(this);
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("refused");
  }
  async query(text: string): Promise<unknown> {
    this.queries.push(text);
    return {};
  }
  on(event: string, listener: (arg: never) => void): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }
  emit(event: string, arg?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) (h as (a: unknown) => void)(arg);
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

describe("pgListen", () => {
  it("listens on email_outbox, wakes on its notifications only, and reconnects after an error", async () => {
    FakeClient.made = [];
    const log = new LineRecorder();
    let wakes = 0;
    const listen = pgListen({ connect: () => new FakeClient(), log, retryMs: 5 });
    const stop = await listen(() => {
      wakes += 1;
    });
    const first = FakeClient.made[0] as FakeClient;
    expect(first.queries).toEqual(["LISTEN email_outbox"]);
    expect(wakes).toBe(1);
    first.emit("notification", { channel: "email_outbox" });
    first.emit("notification", { channel: "other" });
    expect(wakes).toBe(2);
    first.emit("error", new Error("reset"));
    expect(first.ended).toBe(true);
    expect(log.named("background.failed")[0]?.fields).toMatchObject({
      name: "email-listen",
      reason: "error",
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(FakeClient.made).toHaveLength(2);
    expect(wakes).toBe(3);
    await stop();
    expect((FakeClient.made[1] as FakeClient).ended).toBe(true);
  });

  it("closes a client whose connection failed", async () => {
    FakeClient.made = [];
    const listen = pgListen({
      connect: () => Object.assign(new FakeClient(), { failConnect: true }),
      log: new LineRecorder(),
    });
    await expect(listen(() => undefined)).rejects.toThrow("refused");
    expect((FakeClient.made[0] as FakeClient).ended).toBe(true);
  });
});

describe("the delivery check's heartbeat", () => {
  it("pings after a delivery-check email is sent, logging only whether it worked", async () => {
    const calls: string[] = [];
    const log = new LineRecorder();
    const url = "https://heartbeat.example.com/secret-path";
    const hook = onDeliveryCheckSent(log, {
      url,
      fetch: (async (u: string | URL | Request) => {
        calls.push(String(u));
        return new Response("ok");
      }) as typeof fetch,
    });
    await hook({ template: "identity/sign-in-code", emailId: "eml_x" });
    expect(calls).toEqual([]);
    await hook({ template: "ops/delivery-check", emailId: "eml_y" });
    expect(calls).toEqual([url]);
    expect(log.named("job.run")[0]?.fields).toMatchObject({
      job: "email-delivery-check",
      trigger: "sent",
      heartbeat: "ok",
    });
    expect(log.text()).not.toContain("secret-path");
  });

  it("reports a failed or unset ping", async () => {
    const failing = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    expect(await pingHeartbeat({ url: "https://heartbeat.example.com/x", fetch: failing })).toBe(
      "failed",
    );
    const throwing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await pingHeartbeat({ url: "https://heartbeat.example.com/x", fetch: throwing })).toBe(
      "failed",
    );
    expect(await pingHeartbeat({ url: undefined })).toBe("unset");
  });
});
