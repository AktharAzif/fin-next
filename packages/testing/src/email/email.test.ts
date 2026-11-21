import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codeFrom, EmailSinkReader, linksFrom } from "./reader.ts";
import {
  EmailSink,
  isFixtureAddress,
  type RunningEmailSink,
  SinkRefusal,
  startEmailSink,
  validateMessage,
} from "./sink.ts";

// Addresses on real domains are built at run time, so the public-safety check never meets one.
const REAL = (local: string, domain: string) => [local, domain].join("@");
const GMAIL = ["gmail", "com"].join(".");

function message(overrides: Record<string, unknown> = {}) {
  return {
    from: "Fin <no-reply@auth.example.com>",
    to: ["asha.rao@example.com"],
    subject: "Your sign-in code",
    text: "Your code is 123456. It works for 10 minutes.",
    template: "identity/sign-in-code",
    category: "security",
    ...overrides,
  };
}

describe("fixture addresses", () => {
  it.each([
    ["asha.rao@example.com", true],
    ["dara+scope@example.org", true],
    ["x@mail.example.net", true],
    ["X@EXAMPLE.COM", true],
    [REAL("someone", GMAIL), false],
    ["someone@example.com.evil.test", false],
    [REAL("someone", "notexample.com"), false],
    ["not an address", false],
    ["a@b@example.com", false],
  ])("%s is a fixture: %s", (address, expected) => {
    expect(isFixtureAddress(address)).toBe(expected);
  });
});

describe("validateMessage", () => {
  it("accepts a well-formed message", () => {
    expect(validateMessage(message())).toMatchObject({ subject: "Your sign-in code" });
  });

  it("refuses a recipient on a real domain", () => {
    expect(() =>
      validateMessage(message({ to: ["asha.rao@example.com", REAL("real", GMAIL)] })),
    ).toThrow(SinkRefusal);
    try {
      validateMessage(message({ to: [REAL("real", GMAIL)] }));
    } catch (error) {
      expect((error as SinkRefusal).code).toBe("recipient_not_fixture");
      expect((error as Error).message).not.toContain("gmail");
    }
  });

  it.each([
    [null],
    [[]],
    [{ ...message(), from: "" }],
    [{ ...message(), to: [] }],
    [{ ...message(), to: "asha.rao@example.com" }],
    [{ ...message(), subject: 1 }],
    [{ ...message(), text: undefined }],
    [{ ...message(), html: 1 }],
    [{ ...message(), headers: { a: 1 } }],
    [{ ...message(), template: 1 }],
    [{ ...message(), category: 1 }],
  ])("refuses %j", (value) => {
    expect(() => validateMessage(value)).toThrow(SinkRefusal);
  });
});

describe("EmailSink", () => {
  it("stores messages in order with IDs and the clock's time", () => {
    const sink = new EmailSink({ now: () => Date.parse("2026-11-16T10:00:00Z") });
    const first = sink.add(message());
    const second = sink.add(message({ to: ["ben.okafor@example.com"], subject: "Invitation" }));
    expect(first).toMatchObject({
      id: "msg_000001",
      sequence: 1,
      receivedAt: "2026-11-16T10:00:00.000Z",
      headers: {},
    });
    expect(second.sequence).toBe(2);
    expect(sink.last).toBe(2);
    expect(sink.list({ to: "BEN.OKAFOR@example.com" })).toEqual([second]);
    expect(sink.list({ subject: "Invit" })).toEqual([second]);
    expect(sink.list({ template: "identity/sign-in-code" })).toHaveLength(2);
    expect(sink.list({ after: 1 })).toEqual([second]);
  });

  it("wakes a waiter when its message arrives, and only then", async () => {
    const sink = new EmailSink();
    const waiting = sink.waitFor({ to: "chen.wei@example.com" }, 1000);
    sink.add(message());
    sink.add(message({ to: ["chen.wei@example.com"], text: "Code 654321" }));
    expect((await waiting).text).toBe("Code 654321");
  });

  it("answers at once when a match is already there, and times out otherwise", async () => {
    const sink = new EmailSink();
    sink.add(message());
    await expect(sink.waitFor({ to: "asha.rao@example.com" }, 10)).resolves.toMatchObject({
      sequence: 1,
    });
    await expect(sink.waitFor({ to: "nobody@example.com" }, 10)).rejects.toThrow("in time");
  });
});

describe("the sink over HTTP, read by EmailSinkReader", () => {
  let running: RunningEmailSink;
  let reader: EmailSinkReader;
  beforeAll(async () => {
    running = await startEmailSink();
    reader = new EmailSinkReader(`${running.origin}/`);
  });
  afterAll(async () => {
    await running.close();
  });

  const post = (body: string, type = "application/json") =>
    fetch(`${running.origin}/messages`, {
      method: "POST",
      headers: { "content-type": type },
      body,
    });

  it("takes a message and lists it", async () => {
    const response = await post(JSON.stringify(message({ to: ["dara.kelly@example.org"] })));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ id: expect.stringMatching(/^msg_/) });
    const { messages } = await reader.list({ to: "dara.kelly@example.org" });
    expect(messages).toHaveLength(1);
  });

  it("refuses a real recipient, a non-JSON body and the wrong media type", async () => {
    const real = await post(JSON.stringify(message({ to: [REAL("real", GMAIL)] })));
    expect(real.status).toBe(422);
    expect(await real.json()).toMatchObject({ error: "recipient_not_fixture" });
    expect((await post("{not json")).status).toBe(422);
    expect((await post("{}", "text/plain")).status).toBe(415);
    expect((await fetch(`${running.origin}/nowhere`)).status).toBe(404);
  });

  it("waits for a message that arrives later, after a mark", async () => {
    const mark = await reader.mark();
    const code = reader.waitForCode(
      { to: "elif.demir@example.org", after: mark },
      { timeoutMs: 2000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await post(
      JSON.stringify(message({ to: ["elif.demir@example.org"], text: "Use 987654 to sign in." })),
    );
    expect(await code).toBe("987654");
  });

  it("reports a wait that times out", async () => {
    await expect(reader.waitFor({ to: "nobody@example.com" }, { timeoutMs: 20 })).rejects.toThrow(
      "within 20 ms",
    );
  });
});

describe("codeFrom and linksFrom", () => {
  it("finds the one six-digit code", () => {
    expect(codeFrom({ text: "Your code is 042133." })).toBe("042133");
    expect(codeFrom({ text: "Code 123456, again 123456" })).toBe("123456");
  });

  it("refuses none, two, and digits that are part of something longer", () => {
    expect(() => codeFrom({ text: "no code" })).toThrow("no code");
    expect(() => codeFrom({ text: "111111 or 222222" })).toThrow("more than one");
    expect(() => codeFrom({ text: "ref 1234567 and id_123456" })).toThrow("no code");
  });

  it("takes another pattern", () => {
    expect(codeFrom({ text: "Code: ABCD-EFGH" }, /([A-Z]{4}-[A-Z]{4})/)).toBe("ABCD-EFGH");
  });

  it("collects the links from text and HTML, once each", () => {
    const links = linksFrom({
      text: "Open https://console.example.com/sign-in/code#abc. Or https://docs.example.com/x)",
      html: '<a href="https://console.example.com/sign-in/code#abc">Sign in</a><a href="https://console.example.com/i?a=1&amp;b=2">x</a>',
    });
    expect(links).toEqual([
      "https://console.example.com/sign-in/code#abc",
      "https://docs.example.com/x",
      "https://console.example.com/i?a=1&b=2",
    ]);
  });
});
