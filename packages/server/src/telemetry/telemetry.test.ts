// T08-31 and T08-39: the transport, the cap, the queue, the retries, the gap report, and one
// terminal line per unit even when the work throws.
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { capture, type Line } from "../testing/capture.ts";
import { capLine, MAX_LINE_BYTES } from "./cap.ts";
import { batches, betterStackTransport, MAX_BATCH_BYTES, type Transport } from "./ship.ts";

const settle = async (telemetry: { flush(ms: number): Promise<void> }) => telemetry.flush(1000);

describe("the line", () => {
  it("has the envelope, scrubbed, with message equal to event", () => {
    const { telemetry, stdout } = capture();
    telemetry.log("csrf.refused", {
      reason: "origin_missing",
      route: "/api/x?email=a@example.com",
    });
    expect(stdout[0]).toMatchObject({
      dt: "2026-11-21T08:00:00.000Z",
      message: "csrf.refused",
      event: "csrf.refused",
      level: "info",
      service: "console",
      environment: "ci",
      replica: "test",
      reason: "origin_missing",
      route: "/api/x?[query]",
    });
  });

  it("refuses to let fields overwrite the envelope, and withholds withheld names", () => {
    const { telemetry, stdout } = capture();
    telemetry.log("request", {
      service: "evil",
      event: "x",
      email: "a@example.com",
      userId: "usr_1",
    });
    expect(stdout[0]?.service).toBe("console");
    expect(stdout[0]?.event).toBe("request");
    expect(stdout[0]?.email).toBe("[withheld]");
    expect(stdout[0]?.userId).toBe("usr_1");
  });

  it("replaces an event name that is not a bounded code", () => {
    const { telemetry, stdout } = capture();
    telemetry.log("Free text event!", {});
    expect(stdout[0]?.event).toBe("telemetry.bad_event");
  });

  it("is cut at 8 KB with truncated: true", () => {
    const { telemetry, stdout } = capture();
    telemetry.log("request", { route: "x".repeat(20_000), other: "y".repeat(100) });
    const line = stdout[0] as Line;
    expect(Buffer.byteLength(JSON.stringify(line))).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(line.truncated).toBe(true);
    expect(line.event).toBe("request");
    const many: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) many[`k${i}`] = "v";
    const text = capLine({ event: "x", message: "x", ...many });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(JSON.parse(text)).toEqual({ event: "x", message: "x", truncated: true });
  });
});

describe("units", () => {
  it("ship one batch per unit after it ends, even when the work throws", async () => {
    const { telemetry, shipped } = capture({ ship: true });
    await telemetry.withUnit({ requestId: "req_a" }, async () => {
      telemetry.log("csrf.refused", { reason: "app_header" });
      telemetry.log("request", { status: 403 });
    });
    await expect(
      telemetry.withUnit({ requestId: "req_b" }, async () => {
        telemetry.log("request", { status: 500 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await settle(telemetry);
    expect(shipped).toHaveLength(2);
    const a = shipped.find((batch) => batch[0]?.requestId === "req_a");
    const b = shipped.find((batch) => batch[0]?.requestId === "req_b");
    expect(a?.map((l) => l.event)).toEqual(["csrf.refused", "request"]);
    expect(a?.every((l) => l.requestId === "req_a")).toBe(true);
    expect(b?.map((l) => l.event)).toEqual(["request"]);
  });

  it("never delays the answer: the unit returns before its batch is sent", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let sent = 0;
    const transport: Transport = async () => {
      await gate;
      sent++;
      return 202;
    };
    const { telemetry } = capture({ transport });
    const value = await telemetry.withUnit({ requestId: "req_c" }, async () => {
      telemetry.log("request", {});
      return 42;
    });
    expect(value).toBe(42);
    expect(sent).toBe(0);
    expect(telemetry.backgroundCount).toBeGreaterThan(0);
    release();
    await settle(telemetry);
    expect(sent).toBe(1);
  });

  it("puts lines outside a unit on the bounded process queue, oldest dropped first", async () => {
    const { telemetry, shipped } = capture({ ship: true });
    for (let i = 0; i < 1005; i++) telemetry.log("process.health", { i });
    await settle(telemetry);
    const lines = shipped.flat();
    const health = lines.filter((l) => l.event === "process.health");
    expect(health).toHaveLength(1000);
    expect(health[0]?.i).toBe(5);
    const recovered = lines.find((l) => l.event === "telemetry.recovered");
    expect(recovered).toMatchObject({ linesLost: 5 });
  });
});

describe("the transport", () => {
  it("posts Better Stack's JSON array, gzip, with the bearer token", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const token = ["tok", "en", "value"].join("_");
    const transport = betterStackTransport({ host: "s1.eu.example.net", token, fetch: fake });
    const body = new Uint8Array(Buffer.from("x"));
    expect(await transport(body, AbortSignal.timeout(1000))).toBe(202);
    expect(seen[0]?.url).toBe("https://s1.eu.example.net/");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers).toMatchObject({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
    });
  });

  it("splits batches at 256 KB before gzip", () => {
    const line = JSON.stringify({ event: "x", pad: "p".repeat(4000) });
    const groups = batches(Array.from({ length: 200 }, () => line));
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(Buffer.byteLength(`[${group.join(",")}]`)).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }
    expect(groups.flat()).toHaveLength(200);
  });

  it("retries once on 429, 5xx and network errors, never on another 4xx", async () => {
    for (const [statuses, expected] of [
      [[429, 202], 2],
      [[503, 202], 2],
      [["network", 202], 2],
      [[400], 1],
      [[401], 1],
      [[402], 1],
      [[500, 500], 2],
    ] as const) {
      let calls = 0;
      const transport: Transport = async () => {
        const status = statuses[calls++];
        if (status === "network") throw new TypeError("fetch failed");
        return status ?? 202;
      };
      const { telemetry } = capture({ transport });
      await telemetry.withUnit({}, async () => telemetry.log("request", {}));
      await settle(telemetry);
      expect(calls, String(statuses)).toBe(expected);
    }
  });

  it("swallows a failure with telemetry.ship_failed on stdout, then reports the gap", async () => {
    let fail = true;
    const received: Line[][] = [];
    const transport: Transport = async (body) => {
      if (fail) return 402;
      received.push(JSON.parse(gunzipSync(body).toString("utf8")) as Line[]);
      return 202;
    };
    const { telemetry, events } = capture({ transport });
    await telemetry.withUnit({}, async () => {
      telemetry.log("request", {});
      telemetry.log("request", {});
    });
    await settle(telemetry);
    expect(events("telemetry.ship_failed")).toEqual([
      expect.objectContaining({ status: 402, linesLost: 2, level: "warn" }),
    ]);
    fail = false;
    await telemetry.withUnit({}, async () => telemetry.log("request", {}));
    await settle(telemetry);
    expect(received).toHaveLength(1);
    expect(received[0]?.[0]).toMatchObject({
      event: "telemetry.recovered",
      failedSends: 1,
      linesLost: 2,
      statuses: [402],
    });
    await telemetry.withUnit({}, async () => telemetry.log("request", {}));
    await settle(telemetry);
    expect(received[1]?.some((l) => l.event === "telemetry.recovered")).toBe(false);
  });

  it("never ships when no source is configured, and still writes stdout", async () => {
    const { telemetry, stdout } = capture();
    expect(telemetry.shipping).toBe(false);
    await telemetry.withUnit({}, async () => telemetry.log("request", {}));
    await settle(telemetry);
    expect(stdout).toHaveLength(1);
  });
});

describe("background work", () => {
  it("catches a rejection, writes background.failed and calls the hook", async () => {
    const { telemetry, events } = capture();
    const failures: string[] = [];
    telemetry.onBackgroundFailure((_e, name) => failures.push(name));
    telemetry.shipAfter(Promise.reject(new Error("someone@example.com")), "email.send");
    await settle(telemetry);
    expect(events("background.failed")).toEqual([
      expect.objectContaining({ task: "email.send", errorName: "Error", errorCode: "unexpected" }),
    ]);
    expect(JSON.stringify(events("background.failed"))).not.toContain("example.com");
    expect(failures).toEqual(["email.send"]);
  });

  it("flush returns by its deadline even when work hangs", async () => {
    const { telemetry } = capture();
    telemetry.shipAfter(new Promise(() => undefined), "hang");
    const t0 = performance.now();
    await telemetry.flush(50);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
