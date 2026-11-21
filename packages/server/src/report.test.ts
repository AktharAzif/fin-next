// T08-42 and AC-P0-09's server half: reportError returns the errorId, writes error.unexpected with
// safeError's fields only, and sends a scrubbed event with release and environment through the
// Sentry protocol.
import { Refusal } from "@fin/core";
import { describe, expect, it } from "vitest";
import { Reporter } from "./report.ts";
import { isErrorsDsn } from "./report-dsn.ts";
import { capture, TEST_RELEASE } from "./testing/capture.ts";

const dsn = (): string =>
  ["https://", "k".repeat(32), "@s1.eu-nbg-2.betterstackdata.com/4242"].join("");

function fakeErrors() {
  const envelopes: { url: string; items: unknown[] }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const text =
      typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array);
    envelopes.push({
      url,
      items: text
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as unknown),
    });
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { envelopes, fake };
}

describe("Reporter", () => {
  it("writes error.unexpected with safeError fields and returns the errorId", () => {
    const { telemetry, events } = capture();
    const reporter = new Reporter({
      dsn: undefined,
      release: TEST_RELEASE,
      environment: "ci",
      service: "console",
      telemetry,
    });
    const errorId = reporter.reportError(new TypeError("someone@example.com broke"), {
      route: "/api/x",
      requestId: "req_1",
    });
    expect(errorId).toMatch(/^[0-9a-f]{32}$/);
    const [line] = events("error.unexpected");
    expect(line).toMatchObject({
      errorId,
      errorName: "TypeError",
      errorCode: "unexpected",
      route: "/api/x",
      level: "error",
    });
    expect(JSON.stringify(line)).not.toContain("example.com");
    expect(
      Object.keys(line ?? {})
        .filter(
          (k) =>
            ![
              "dt",
              "message",
              "event",
              "level",
              "service",
              "environment",
              "release",
              "replica",
            ].includes(k),
        )
        .sort(),
    ).toEqual(["errorCode", "errorId", "errorName", "frames", "route"]);
  });

  it("sends a scrubbed event with release, environment and the ID tags", async () => {
    const { telemetry } = capture();
    const { envelopes, fake } = fakeErrors();
    const reporter = new Reporter({
      dsn: dsn(),
      release: TEST_RELEASE,
      environment: "staging",
      service: "console",
      telemetry,
      fetch: fake,
    });
    expect(reporter.sending).toBe(true);
    const errorId = reporter.reportError(new Error("token for someone@example.com"), {
      requestId: "req_2",
      orgId: "org_1",
    });
    await reporter.flush(2000);
    expect(envelopes).toHaveLength(1);
    const envelope = envelopes[0];
    expect(envelope?.url).toContain("s1.eu-nbg-2.betterstackdata.com/api/4242/envelope/");
    const event = envelope?.items[2] as Record<string, unknown>;
    expect(event.event_id).toBe(errorId);
    expect(event).toMatchObject({ release: TEST_RELEASE, environment: "staging" });
    expect(event.tags).toMatchObject({
      requestId: "req_2",
      orgId: "org_1",
      service: "console",
      fin_fixed_message: "false",
    });
    const text = JSON.stringify(event);
    expect(text).not.toContain("example.com");
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.server_name).toBeUndefined();
    const exception = (event.exception as { values: { value: string; type: string }[] }).values[0];
    expect(exception?.type).toBe("Error");
    expect(exception?.value).toBe("[withheld]");
  });

  it("keeps a FinError's fixed message", async () => {
    const { telemetry } = capture();
    const { envelopes, fake } = fakeErrors();
    const reporter = new Reporter({
      dsn: dsn(),
      release: TEST_RELEASE,
      environment: "staging",
      service: "console",
      telemetry,
      fetch: fake,
    });
    reporter.reportError(new Refusal("forbidden", 403, "Fin's own words"));
    await reporter.flush(2000);
    const event = envelopes[0]?.items[2] as { exception: { values: { value: string }[] } };
    expect(event.exception.values[0]?.value).toBe("Fin's own words");
  });

  it("sends no message text as a frame or a type, whatever the message and the name hold", async () => {
    const { telemetry, events } = capture();
    const { envelopes, fake } = fakeErrors();
    const reporter = new Reporter({
      dsn: dsn(),
      release: TEST_RELEASE,
      environment: "staging",
      service: "console",
      telemetry,
      fetch: fake,
    });
    const error = new Error(
      'invalid input syntax for type integer: "1\n    at Jane Doe of 12 High Street (/vault/hunter2-Password/card:4111:1111)',
    );
    reporter.reportError(error);
    const named = new TypeError("x");
    named.name = "Refused for Jane Doe hunter2-Password";
    reporter.reportError(named);
    await reporter.flush(2000);
    expect(envelopes).toHaveLength(2);
    type Sent = {
      exception: { values: { type: string; stacktrace?: { frames: { filename?: string }[] } }[] };
    };
    const types: string[] = [];
    for (const envelope of envelopes) {
      const event = envelope.items[2] as Sent;
      const text = JSON.stringify(event);
      expect(text).not.toMatch(/Jane|High Street|hunter2|vault|4111/);
      const value = event.exception.values[0];
      types.push(value?.type ?? "");
      expect(value?.stacktrace?.frames.length).toBeGreaterThan(0);
      expect(value?.stacktrace?.frames.at(-1)?.filename).toMatch(/report\.test\.ts$/);
    }
    expect(types).toEqual(["Error", "TypeError"]);
    expect(JSON.stringify(events("error.unexpected"))).not.toMatch(/Jane|hunter2|vault/);
  });

  it("never throws when the Errors endpoint fails", async () => {
    const { telemetry, events } = capture();
    const failing = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const reporter = new Reporter({
      dsn: dsn(),
      release: TEST_RELEASE,
      environment: "staging",
      service: "console",
      telemetry,
      fetch: failing,
    });
    expect(() => reporter.reportError(new Error("x"))).not.toThrow();
    await reporter.flush(500);
    expect(events("error.unexpected")).toHaveLength(1);
  });
});

describe("the DSN shape", () => {
  it("accepts Better Stack's shape only", () => {
    expect(isErrorsDsn(dsn())).toBe(true);
    // Built at run time: an address-shaped DSN is never written out in the file.
    const at = (scheme: string, key: string, host: string, path: string): string =>
      [scheme, "://", key, "@", host, path].join("");
    const key = "k".repeat(32);
    for (const bad of [
      at("http", key, "s1.betterstackdata.com", "/1"),
      at("https", "short", "s1.betterstackdata.com", "/1"),
      at("https", key, "sentry.example.com", "/1"),
      at("https", key, "s1.betterstackdata.com.example.com", "/1"),
      at("https", key, "s1.betterstackdata.com", "/abc"),
      at("https", `${key}:secret`, "s1.betterstackdata.com", "/1"),
    ]) {
      expect(isErrorsDsn(bad), bad).toBe(false);
    }
  });
});
