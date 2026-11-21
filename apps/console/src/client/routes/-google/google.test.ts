// The Google button's pieces (spec 02 §5.8, §2.3): where the round trip comes back to, the
// refusals the pages read from `?error=`, and the provider addresses the browser may be sent to.
import { describe, expect, it } from "vitest";
import {
  GOOGLE_ERRORS,
  googleAlert,
  googleReturn,
  googleStart,
  googleState,
  isGoogleError,
  providerUrl,
  signInMethods,
} from "./google.ts";

describe("googleReturn", () => {
  it("comes back to the sign-in page with via=google, and a refusal to the page it began on", () => {
    expect(googleReturn("/sign-in", null)).toEqual({
      callbackURL: "/sign-in?via=google",
      errorCallbackURL: "/sign-in",
    });
    expect(googleReturn("/sign-up", "/")).toEqual({
      callbackURL: "/sign-in?via=google",
      errorCallbackURL: "/sign-up",
    });
  });

  it("keeps a next for after the sign-in, on both ways back", () => {
    expect(googleReturn("/sign-in", "/settings/team?view=invite")).toEqual({
      callbackURL: "/sign-in?via=google&next=%2Fsettings%2Fteam%3Fview%3Dinvite",
      errorCallbackURL: "/sign-in?next=%2Fsettings%2Fteam%3Fview%3Dinvite",
    });
  });
});

describe("the refusals a round trip comes back with", () => {
  it("knows each code the callback sends, and nothing else", () => {
    for (const code of GOOGLE_ERRORS) expect(isGoogleError(code)).toBe(true);
    for (const value of ["signed_out", "too_many_tries", "", null, 3, "ACCOUNT_NOT_LINKED"]) {
      expect(isGoogleError(value)).toBe(false);
    }
  });

  it("draws each as one of the SignIn board's Google states", () => {
    expect(Object.fromEntries(GOOGLE_ERRORS.map((code) => [code, googleState(code)]))).toEqual({
      access_denied: "googleCancelled",
      account_not_linked: "googleNotLinked",
      email_unverified: "googleUnconfirmed",
      unable_to_create_user: "googleNoSignup",
      signup_disabled: "googleNoSignup",
      google_failed: "googleOurSide",
      invalid_code: "googleOurSide",
      unable_to_get_user_info: "googleOurSide",
      internal_server_error: "googleOurSide",
      email_not_found: "googleIncomplete",
      state_mismatch: "googleUnfinished",
      state_not_found: "googleUnfinished",
      no_code: "googleUnfinished",
    });
  });

  it("says what happened in Fin's words, never asking for anything typed", () => {
    expect(googleAlert("account_not_linked")).toEqual({
      tone: "warning",
      title: "This email already has a Fin account.",
      body: "Sign in with a passkey or your email. You can link Google in Account security.",
    });
    expect(googleAlert("access_denied").tone).toBe("info");
    expect(googleAlert("google_failed").tone).toBe("danger");
    for (const code of GOOGLE_ERRORS) {
      expect(googleAlert(code).title).not.toMatch(/project/i);
      expect(googleAlert(code).body).toMatch(/email/);
    }
  });
});

describe("providerUrl", () => {
  it("sends the browser only to https, or to plain http on loopback", () => {
    expect(providerUrl("https://accounts.google.com/o/oauth2/v2/auth?x=1")).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth?x=1",
    );
    expect(providerUrl("http://127.0.0.1:4121/authorize")).toBe("http://127.0.0.1:4121/authorize");
    for (const value of [
      "http://accounts.google.com/",
      "javascript:alert(1)",
      "data:text/html,x",
      // Credentials in the address, built at run time (the shape alone reads as an address).
      ["https://user:pass", "accounts.google.com/"].join("@"),
      "/relative",
      "",
    ]) {
      expect(providerUrl(value), value).toBeNull();
    }
  });
});

describe("the contracts", () => {
  it("name the console's routes under /api", () => {
    expect(signInMethods).toMatchObject({ method: "GET", path: "/sign-in/methods" });
    expect(googleStart).toMatchObject({ method: "POST", path: "/auth/sign-in/social" });
    expect(
      googleStart.input.safeParse({
        provider: "google",
        callbackURL: "/sign-in?via=google",
        errorCallbackURL: "/sign-in",
        disableRedirect: true,
      }).success,
    ).toBe(true);
    expect(googleStart.input.safeParse({ provider: "github" }).success).toBe(false);
  });
});
