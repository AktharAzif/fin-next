// The realm's calls in order: options, the browser's prompt, the response; the intent on both
// halves of a step-up; nothing sent when the prompt does not finish.
import { describe, expect, it, vi } from "vitest";
import { addPasskey, askPasskeyIntent, sendSignInCode, totpUriOf, usePasskey } from "./library.ts";

function transport(answers: Response[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
    [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init?.method),
      headers: { ...(init?.headers as Record<string, string>) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = answers.shift();
    if (next === undefined) throw new Error("no more answers");
    return next;
  }) as unknown as typeof globalThis.fetch;
  return { transport: { fetch }, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("a passkey assertion", () => {
  it("fetches options, runs the prompt and sends its response, with the intent on both", async () => {
    const { transport: t, calls } = transport([
      json(200, { challenge: "c1" }),
      json(200, { ok: true }),
    ]);
    const authenticate = vi.fn(async (options: unknown) => ({
      ok: true as const,
      response: { id: "cred", seen: options },
    }));
    const outcome = await usePasskey("sti_9", { transport: t, authenticate });
    expect(outcome).toEqual({ kind: "done", data: { ok: true } });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/auth/passkey/generate-authenticate-options",
      "POST /api/auth/passkey/verify-authentication",
    ]);
    expect(calls.map((c) => c.headers["Fin-Step-Up-Intent"])).toEqual(["sti_9", "sti_9"]);
    expect(calls[1]?.body).toEqual({ response: { id: "cred", seen: { challenge: "c1" } } });
  });

  it("sends nothing more when the prompt is closed", async () => {
    const { transport: t, calls } = transport([json(200, { challenge: "c1" })]);
    const authenticate = vi.fn(async () => ({ ok: false as const, reason: "cancelled" as const }));
    expect(await usePasskey(null, { transport: t, authenticate })).toEqual({
      kind: "ceremony",
      reason: "cancelled",
    });
    expect(calls).toHaveLength(1);
  });

  it("stops at refused options", async () => {
    const { transport: t } = transport([json(429, { code: "TOO_MANY_REQUESTS", message: "x" })]);
    const authenticate = vi.fn();
    const outcome = await usePasskey(null, { transport: t, authenticate });
    expect(outcome).toMatchObject({ kind: "refused", failure: { kind: "library", status: 429 } });
    expect(authenticate).not.toHaveBeenCalled();
  });
});

describe("adding a passkey", () => {
  it("registers with the realm's options and sends the new credential", async () => {
    const { transport: t, calls } = transport([
      json(200, { challenge: "r1" }),
      json(200, { id: "pky_1" }),
    ]);
    const register = vi.fn(async () => ({ ok: true as const, response: { id: "new" } }));
    expect(await addPasskey(null, { transport: t, register })).toEqual({
      kind: "done",
      data: { id: "pky_1" },
    });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/auth/passkey/generate-register-options",
      "POST /api/auth/passkey/verify-registration",
    ]);
  });

  it("asks for the intent with a body-less registration", async () => {
    const { transport: t, calls } = transport([json(200, {})]);
    await askPasskeyIntent({ transport: t });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/api/auth/passkey/verify-registration",
      body: {},
    });
    expect(calls[0]?.headers["X-Fin-App"]).toBe("admin");
  });
});

describe("the emailed code", () => {
  it("is asked for as a sign-in code only", async () => {
    const { transport: t, calls } = transport([json(200, { success: true })]);
    await sendSignInCode("nadia@example.com", { transport: t });
    expect(calls[0]?.body).toEqual({ email: "nadia@example.com", type: "sign-in" });
  });
});

describe("totpUriOf", () => {
  it("reads only an otpauth URI", () => {
    expect(totpUriOf({ totpURI: "otpauth://totp/x?secret=ABC" })).toBe(
      "otpauth://totp/x?secret=ABC",
    );
    expect(totpUriOf({ totpURI: "https://example.com" })).toBeNull();
    expect(totpUriOf(null)).toBeNull();
  });
});
