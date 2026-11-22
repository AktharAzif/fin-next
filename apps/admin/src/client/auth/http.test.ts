// The staff realm's calls follow api()'s rules (FW-C08, FW-C09): same-origin under /api/auth, the
// app header on unsafe calls only, JSON or no body, manual redirects, and both kinds of refusal
// read as data.
import { describe, expect, it, vi } from "vitest";
import { authRequest, failureCode, problemField } from "./http.ts";

type Seen = { url: string; init: RequestInit };

function fakeFetch(response: Response | (() => Promise<Response>)) {
  const seen: Seen[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return typeof response === "function" ? response() : response.clone();
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, seen };
}

function headersOf(seen: Seen): Record<string, string> {
  return { ...(seen.init.headers as Record<string, string>) };
}

const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });

describe("authRequest", () => {
  it("sends a POST same-origin under /api/auth with the app header and a JSON body", async () => {
    const { fetch, seen } = fakeFetch(json(200, { success: true }));
    const answer = await authRequest(
      {
        method: "POST",
        path: "/email-otp/send-verification-otp",
        body: { email: "a@example.com", type: "sign-in" },
      },
      { fetch },
    );
    expect(answer).toEqual({ ok: true, status: 200, data: { success: true } });
    const [call] = seen;
    expect(call?.url).toBe("/api/auth/email-otp/send-verification-otp");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.credentials).toBe("same-origin");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.cache).toBe("no-store");
    expect(call?.init.body).toBe(JSON.stringify({ email: "a@example.com", type: "sign-in" }));
    expect(headersOf(call as Seen)).toEqual({
      Accept: "application/json",
      "X-Fin-App": "admin",
      "Content-Type": "application/json",
    });
  });

  it("sends a GET with no app header, no body and no content type", async () => {
    const { fetch, seen } = fakeFetch(json(200, { challenge: "abc" }));
    await authRequest({ method: "GET", path: "/passkey/generate-authenticate-options" }, { fetch });
    expect(headersOf(seen[0] as Seen)).toEqual({ Accept: "application/json" });
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("names the proved intent, and only when there is one", async () => {
    const { fetch, seen } = fakeFetch(json(200, {}));
    await authRequest(
      {
        method: "POST",
        path: "/two-factor/verify-totp",
        body: { code: "123456" },
        intentId: "sti_1",
      },
      { fetch },
    );
    await authRequest(
      { method: "POST", path: "/two-factor/verify-totp", body: { code: "123456" }, intentId: null },
      { fetch },
    );
    expect(headersOf(seen[0] as Seen)["Fin-Step-Up-Intent"]).toBe("sti_1");
    expect(headersOf(seen[1] as Seen)["Fin-Step-Up-Intent"]).toBeUndefined();
  });

  it("sends a body-less POST with no content type", async () => {
    const { fetch, seen } = fakeFetch(new Response(null, { status: 204 }));
    const answer = await authRequest({ method: "POST", path: "/sign-out" }, { fetch });
    expect(answer).toEqual({ ok: true, status: 204, data: null });
    expect(headersOf(seen[0] as Seen)["Content-Type"]).toBeUndefined();
    expect(seen[0]?.init.body).toBeUndefined();
  });

  it("reads the library's own refusal by its code", async () => {
    const { fetch } = fakeFetch(json(400, { code: "INVALID_OTP", message: "Invalid OTP" }));
    const answer = await authRequest(
      { method: "POST", path: "/sign-in/email-otp", body: {} },
      { fetch },
    );
    expect(answer).toEqual({ ok: false, kind: "library", status: 400, code: "INVALID_OTP" });
    if (!answer.ok) expect(failureCode(answer)).toBe("INVALID_OTP");
  });

  it("reads Fin's problem document, with the wait of a 429", async () => {
    const problem = {
      type: "https://docs.example.com/errors/rate_limited",
      title: "Too many tries. Wait a moment.",
      status: 429,
      code: "rate_limited",
      request_id: "req_1",
      retry_after: 30,
    };
    const { fetch } = fakeFetch(
      json(429, problem, { "content-type": "application/problem+json", "retry-after": "30" }),
    );
    const answer = await authRequest(
      { method: "POST", path: "/sign-in/email-otp", body: {} },
      { fetch },
    );
    expect(answer).toMatchObject({
      ok: false,
      kind: "problem",
      status: 429,
      retryAfterSeconds: 30,
    });
    if (!answer.ok) {
      expect(failureCode(answer)).toBe("rate_limited");
      expect(problemField(answer, "request_id")).toBe("req_1");
    }
  });

  it("calls a problem whose status disagrees with the answer unexpected", async () => {
    const { fetch } = fakeFetch(
      json(
        403,
        { type: "x", title: "x", status: 400, code: "invalid" },
        {
          "content-type": "application/problem+json",
        },
      ),
    );
    const answer = await authRequest({ method: "POST", path: "/x", body: {} }, { fetch });
    expect(answer).toEqual({ ok: false, kind: "unexpected", status: 403 });
  });

  it("calls a page that is not JSON unexpected, even with a 200", async () => {
    const { fetch } = fakeFetch(
      new Response("<html>blocked</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    expect(await authRequest({ method: "GET", path: "/x" }, { fetch })).toEqual({
      ok: false,
      kind: "unexpected",
      status: 200,
    });
  });

  it("says network when there is no answer at all", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof globalThis.fetch;
    expect(await authRequest({ method: "GET", path: "/x" }, { fetch })).toEqual({
      ok: false,
      kind: "network",
    });
  });

  it("hands an opaque redirect (Access ended the session) to the reload hook", async () => {
    const opaque = {
      type: "opaqueredirect",
      status: 0,
      headers: new Headers(),
    } as unknown as Response;
    const fetch = vi.fn(async () => opaque) as unknown as typeof globalThis.fetch;
    const onAccessRedirect = vi.fn();
    expect(
      await authRequest({ method: "POST", path: "/sign-out" }, { fetch, onAccessRedirect }),
    ).toEqual({ ok: false, kind: "access" });
    expect(onAccessRedirect).toHaveBeenCalledOnce();
  });
});
