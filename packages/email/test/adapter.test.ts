// The Cloudflare adapter against a fake fetch (ARCHITECTURE §9.3): what it sends, how it reads the
// answer (codes and lengths only), and when it retries.
import { describe, expect, it } from "vitest";
import type { OutgoingEmail } from "../src/port.ts";
import {
  AdapterConfigError,
  CloudflareEmailAdapter,
  classify,
  parseAnswer,
  parseRetryAfter,
  readCapped,
} from "../src/providers/cloudflare/adapter.ts";

// Built at run time so no account- or token-shaped literal sits in the repository.
const ACCOUNT = "0f".repeat(16);
const TOKEN = ["test", "token", "value", "for", "the", "adapter"].join("-");

const MESSAGE: OutgoingEmail = {
  from: { address: "account-security@auth.example.com", name: "Fin" },
  to: "person@example.com",
  subject: "Your Fin sign-in code",
  text: "text",
  html: "<p>html</p>",
  headers: {
    "Auto-Submitted": "auto-generated",
    "X-Entity-Ref-ID": "ref-1",
    "X-Fin-Category": "code",
  },
  template: "identity/sign-in-code",
  category: "code",
};

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const success = (result: Record<string, unknown[]>) => ({
  success: true,
  errors: [],
  messages: [],
  result: {
    message_id: "<m@example.com>",
    delivered: [],
    permanent_bounces: [],
    queued: [],
    suppressed_recipients: [],
    ...result,
  },
});

const failure = (code: number) => ({
  success: false,
  errors: [{ code, message: "x" }],
  messages: [],
  result: null,
});

interface Line {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly level: string | undefined;
}

function harness(answers: (Response | Error | (() => Promise<Response>))[]) {
  const calls: Call[] = [];
  const lines: Line[] = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = answers.shift();
    if (next === undefined) throw new Error("no answer scripted");
    if (next instanceof Error) throw next;
    if (typeof next === "function") return next();
    now += 100;
    return next;
  }) as typeof fetch;
  const adapter = new CloudflareEmailAdapter({
    accountId: ACCOUNT,
    token: TOKEN,
    fetch: fetchImpl,
    clock: { now: () => now },
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
    random: () => 0.5,
    log: { log: (event, fields, level) => lines.push({ event, fields, level }) },
  });
  return { adapter, calls, sleeps, lines, advance: (ms: number) => (now += ms) };
}

describe("CloudflareEmailAdapter", () => {
  it("posts one message to the send endpoint with the bearer token and Fin's body", async () => {
    const h = harness([json(200, success({ delivered: ["person@example.com"] }))]);
    const outcome = await h.adapter.send(MESSAGE);
    expect(outcome).toMatchObject({ ok: true, status: "delivered", tries: 1, httpStatus: 200 });
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0] as Call;
    expect(call.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/send`,
    );
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("error");
    expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(call.init.body));
    expect(body).toEqual({
      from: { address: "account-security@auth.example.com", name: "Fin" },
      to: "person@example.com",
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
      headers: MESSAGE.headers,
    });
  });

  it("counts queued as sent", async () => {
    const h = harness([json(200, success({ queued: ["x"] }))]);
    expect(await h.adapter.send(MESSAGE)).toMatchObject({ ok: true, status: "queued" });
  });

  it("fails a 200 with a permanent bounce or a suppressed recipient, without retrying", async () => {
    const bounced = harness([json(200, success({ permanent_bounces: ["x"] }))]);
    expect(await bounced.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "permanent",
      code: "bounced",
    });
    const suppressed = harness([json(200, success({ suppressed_recipients: ["x"] }))]);
    expect(await suppressed.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "permanent",
      code: "suppressed",
    });
    expect(suppressed.calls).toHaveLength(1);
  });

  it("retries 429 with code 10004 in line, with jittered backoff, and then succeeds", async () => {
    const h = harness([
      json(429, failure(10004)),
      json(429, failure(10004)),
      json(200, success({ delivered: ["x"] })),
    ]);
    const outcome = await h.adapter.send(MESSAGE);
    expect(outcome).toMatchObject({ ok: true, tries: 3 });
    expect(h.sleeps).toEqual([200, 400]);
  });

  it("writes one provider.call line per try, with IDs and codes only (ARCHITECTURE §10.2)", async () => {
    const h = harness([json(429, failure(10004)), json(200, success({ delivered: ["x"] }))]);
    await h.adapter.send({ ...MESSAGE, emailId: "eml_01jd0000000000000000000000" });
    const calls = h.lines.filter((l) => l.event === "provider.call");
    expect(calls.map((l) => l.fields)).toEqual([
      {
        provider: "cloudflare-email",
        operation: "send",
        status: 429,
        durationMs: 100,
        outcome: "retry",
        failure: "rate_limited",
        code: "cf_10004",
        retry: 0,
        template: "identity/sign-in-code",
        class: "code",
        emailId: "eml_01jd0000000000000000000000",
      },
      {
        provider: "cloudflare-email",
        operation: "send",
        status: 200,
        durationMs: 100,
        outcome: "ok",
        retry: 1,
        template: "identity/sign-in-code",
        class: "code",
        emailId: "eml_01jd0000000000000000000000",
      },
    ]);
    expect(JSON.stringify(h.lines)).not.toContain("@");
  });

  it.each<[Response | Error, Record<string, unknown>]>([
    [json(401, failure(10000)), { outcome: "refused", failure: "unauthorized", status: 401 }],
    [json(403, failure(10203)), { outcome: "refused", failure: "forbidden", status: 403 }],
    [json(400, failure(10001)), { outcome: "refused", code: "cf_10001", status: 400 }],
    [json(500, failure(10002)), { outcome: "unknown", failure: "server_error", status: 500 }],
    [json(503, {}), { outcome: "unknown", failure: "unavailable", status: 503 }],
    [json(200, { success: false }), { outcome: "unknown", failure: "invalid_response" }],
    [
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      { outcome: "unknown", failure: "timeout" },
    ],
    [new TypeError("fetch failed"), { outcome: "unknown", failure: "network" }],
  ])("names a failed call's outcome and failure (%#)", async (answer, expected) => {
    const h = harness([answer]);
    await h.adapter.send(MESSAGE);
    const calls = h.lines.filter((l) => l.event === "provider.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.fields).toMatchObject({ retry: 0, ...expected });
    expect(calls[0]?.level).toBe("warn");
  });

  it("names only Cloudflare's own small numeric codes, so the outbox's error code keeps its shape", async () => {
    for (const odd of [-1, 1e21, 2 ** 53, 0.5]) {
      const h = harness([json(500, { success: false, errors: [{ code: odd }] })]);
      const outcome = await h.adapter.send(MESSAGE);
      expect(outcome).toMatchObject({ ok: false, code: "http_500" });
    }
    const h = harness([json(500, failure(10002))]);
    expect(await h.adapter.send(MESSAGE)).toMatchObject({ code: "cf_10002" });
  });

  it("writes no provider.call when a header is refused before any call", async () => {
    const h = harness([]);
    await h.adapter.send({ ...MESSAGE, headers: { "List-Unsubscribe": "<x>" } });
    expect(h.lines).toEqual([]);
  });

  it("stops after three tries and hands the throttle back to the outbox", async () => {
    const h = harness([
      json(429, failure(10004)),
      json(429, failure(10004)),
      json(429, failure(10004), { "retry-after": "3" }),
    ]);
    const outcome = await h.adapter.send(MESSAGE);
    expect(outcome).toMatchObject({
      ok: false,
      kind: "throttled",
      code: "cf_10004",
      tries: 3,
      retryAfterMs: 3000,
    });
  });

  it("does not retry a retry-after beyond the 7 s budget", async () => {
    const h = harness([json(429, failure(10004), { "retry-after": "60" })]);
    const outcome = await h.adapter.send(MESSAGE);
    expect(outcome).toMatchObject({ ok: false, kind: "throttled", tries: 1, retryAfterMs: 60_000 });
    expect(h.sleeps).toEqual([]);
  });

  it("never retries a 429 that is not 10004 in line", async () => {
    const h = harness([json(429, failure(971))]);
    expect(await h.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "throttled",
      code: "cf_971",
      tries: 1,
    });
  });

  it("never retries a 5xx, a timeout or a network error: the message may have gone", async () => {
    const server = harness([json(500, failure(10002))]);
    expect(await server.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "unknown",
      code: "cf_10002",
      tries: 1,
    });
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const slow = harness([timeout]);
    expect(await slow.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "unknown",
      code: "timeout",
      tries: 1,
    });
    const network = harness([new TypeError("fetch failed")]);
    expect(await network.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "unknown",
      code: "network",
    });
  });

  it("aborts a try at 5 s through the timeout signal", async () => {
    let seenMs = 0;
    const adapter = new CloudflareEmailAdapter({
      accountId: ACCOUNT,
      token: TOKEN,
      fetch: (async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })) as typeof fetch,
      timeoutSignal: (ms) => {
        seenMs = ms;
        return AbortSignal.timeout(5);
      },
    });
    expect(await adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "unknown",
      code: "timeout",
    });
    expect(seenMs).toBe(5000);
  });

  it("pages on the token, entitlement and account codes", async () => {
    for (const [status, code] of [
      [401, 10101],
      [403, 10102],
      [403, 10105],
      [403, 10203],
      [403, 10207],
    ] as const) {
      const h = harness([json(status, failure(code))]);
      expect(await h.adapter.send(MESSAGE)).toMatchObject({
        ok: false,
        kind: "blocked",
        code: `cf_${code}`,
        severity: "page",
      });
    }
    const bare = harness([new Response("", { status: 401 })]);
    expect(await bare.adapter.send(MESSAGE)).toMatchObject({ kind: "blocked", code: "http_401" });
  });

  it("never retries and alerts on schema, size, length and invalid content", async () => {
    for (const code of [10001, 10200, 10201, 10202]) {
      const h = harness([json(400, failure(code))]);
      expect(await h.adapter.send(MESSAGE)).toMatchObject({
        ok: false,
        kind: "permanent",
        code: `cf_${code}`,
        severity: "alert",
        tries: 1,
      });
    }
  });

  it("refuses a header Cloudflare would refuse before calling", async () => {
    const h = harness([]);
    const outcome = await h.adapter.send({
      ...MESSAGE,
      headers: { ...MESSAGE.headers, "Message-ID": "<x@example.com>" },
    });
    expect(outcome).toMatchObject({
      ok: false,
      kind: "permanent",
      code: "header_refused",
      tries: 0,
    });
    expect(h.calls).toHaveLength(0);
  });

  it("treats a 2xx that is not success as an untrusted answer", async () => {
    const h = harness([new Response("<html>gateway</html>", { status: 200 })]);
    expect(await h.adapter.send(MESSAGE)).toMatchObject({
      ok: false,
      kind: "unknown",
      code: "invalid_response",
    });
  });

  it("refuses a malformed account ID or token at construction, naming the variable only", () => {
    expect(() => new CloudflareEmailAdapter({ accountId: "nope", token: TOKEN })).toThrow(
      AdapterConfigError,
    );
    expect(() => new CloudflareEmailAdapter({ accountId: ACCOUNT, token: "short" })).toThrow(
      /FIN_EMAIL_TOKEN/u,
    );
  });
});

describe("answer parsing", () => {
  it("reads only success, numeric codes and array lengths", () => {
    const a = parseAnswer(
      200,
      JSON.stringify(success({ delivered: ["a@example.com", "b@example.com"] })),
      undefined,
    );
    expect(a).toEqual({
      status: 200,
      retryAfterMs: undefined,
      success: true,
      codes: [],
      counts: { delivered: 2, queued: 0, bounced: 0, suppressed: 0 },
    });
    expect(JSON.stringify(a)).not.toContain("@");
  });

  it("survives a body that is not JSON", () => {
    expect(parseAnswer(502, "Bad gateway", undefined).codes).toEqual([]);
  });

  it("classifies an accepted answer with no recipient as unknown, never resent in line", () => {
    expect(classify(parseAnswer(200, JSON.stringify(success({})), undefined))).toMatchObject({
      ok: false,
      kind: "unknown",
      retryInLine: false,
    });
  });

  it("parses retry-after as seconds or a date", () => {
    expect(parseRetryAfter("7", 0)).toBe(7000);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfter("soon", 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });

  it("reads at most the cap of a body", async () => {
    const big = new Response("x".repeat(40_000));
    expect((await readCapped(big, 16_384)).length).toBe(16_384);
  });
});
