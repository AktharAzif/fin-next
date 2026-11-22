// "Continue with Google" on AdminSignIn (stretch 5): the start is one gated POST that asks for the
// sign-in page back either way and never a new-user page; only an https (or loopback) provider
// address is followed; and every refusal the realm sends back has its words on the card, while an
// unknown `?error=` draws nothing.
import { describe, expect, it, vi } from "vitest";
import { GOOGLE_ERRORS, googleAlert, googleErrorOf, providerUrl, startGoogle } from "./google.ts";

describe("starting a staff Google round trip", () => {
  it("POSTs the start with X-Fin-App, coming back to the sign-in page, redirect only", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ url: "https://accounts.google.com/o/oauth2/v2/auth" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    const answer = await startGoogle({ fetch });
    expect(answer).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call === undefined) throw new Error("nothing was sent");
    expect(call.url).toBe("/api/auth/sign-in/social");
    expect(call.init?.method).toBe("POST");
    const headers = (call.init?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Fin-App"]).toBe("admin");
    expect(JSON.parse(String(call.init?.body))).toEqual({
      provider: "google",
      callbackURL: "/sign-in",
      errorCallbackURL: "/sign-in",
      disableRedirect: true,
    });
  });
});

describe("the provider's address", () => {
  it("is followed only over https, or plain http on loopback", () => {
    expect(providerUrl({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" })).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    );
    expect(providerUrl({ url: "http://127.0.0.1:4121/authorize" })).toBe(
      "http://127.0.0.1:4121/authorize",
    );
    for (const url of [
      "http://accounts.example.com/authorize",
      "javascript:alert(1)",
      "https://user:secret@accounts.example.com/",
      "not a url",
    ]) {
      expect(providerUrl({ url }), url).toBeNull();
    }
    expect(providerUrl(null)).toBeNull();
    expect(providerUrl({})).toBeNull();
  });
});

describe("a refused round trip (googleFailed)", () => {
  it("reads only the refusals the realm sends", () => {
    expect(googleErrorOf("account_refused")).toBe("account_refused");
    expect(googleErrorOf("access_denied")).toBe("access_denied");
    expect(googleErrorOf("<script>")).toBeNull();
    expect(googleErrorOf(undefined)).toBeNull();
    expect(googleErrorOf(["account_refused"])).toBeNull();
  });

  it("says who may sign in when the account is refused, and what to do for each other refusal", () => {
    expect(googleAlert("account_refused")).toEqual({
      tone: "warning",
      title: "That Google account can’t sign in to Fin Admin.",
      body: "Use your Fin work account, the one Cloudflare Access signed you in with.",
    });
    expect(googleAlert("access_denied").tone).toBe("info");
    expect(googleAlert("google_failed").title).toBe("Google sign-in isn’t working right now.");
    expect(googleAlert("state_mismatch").title).toBe("Google sign-in didn’t finish.");
    for (const error of GOOGLE_ERRORS) {
      const alert = googleAlert(error);
      expect(alert.title.length, error).toBeGreaterThan(10);
      expect(alert.body.length, error).toBeGreaterThan(10);
    }
  });
});
