// A Google callback's OAuth state as the realm reads it before any exchange (spec 02 §5.8): the
// stored state's fields, its expiry and Fin's claim on it, and the state cookie's signature checked
// as the library signs it. The claim itself (the row's lock) is proven on Postgres in
// google.db.test.ts, together with the library's own cookie.
import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LINK_INTENT_KEY,
  parseStoredState,
  STATE_CLAIM_KEY,
  stateIdentifier,
  verifiedCookieValue,
} from "./state.ts";

const NOW = Date.parse("2026-11-21T12:00:00Z");
const INTENT = "sti_01jd0000000000000000000000";

function stored(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    callbackURL: "https://console.example.com/sign-in?via=google",
    codeVerifier: "v".repeat(64),
    idTokenNonce: "n".repeat(32),
    errorURL: "https://console.example.com/sign-in",
    expiresAt: NOW + 600_000,
    oauthState: "s".repeat(32),
    ...fields,
  });
}

describe("parseStoredState", () => {
  it("reads the verifier, the nonce, the error page and a link's intent from the server context", () => {
    expect(parseStoredState(stored({ serverContext: { [LINK_INTENT_KEY]: INTENT } }), NOW)).toEqual(
      {
        codeVerifier: "v".repeat(64),
        idTokenNonce: "n".repeat(32),
        linkIntentId: INTENT,
        errorURL: "https://console.example.com/sign-in",
        claimed: false,
      },
    );
  });

  it("reads Fin's claim, and never an intent the client could have put elsewhere", () => {
    expect(parseStoredState(stored({ [STATE_CLAIM_KEY]: "req_x" }), NOW)?.claimed).toBe(true);
    for (const fields of [
      { [LINK_INTENT_KEY]: INTENT },
      { serverContext: { [LINK_INTENT_KEY]: "sti_not-an-id" } },
      { serverContext: "x" },
    ]) {
      expect(parseStoredState(stored(fields), NOW)?.linkIntentId).toBeNull();
    }
    expect(parseStoredState(stored({ errorURL: 3 }), NOW)?.errorURL).toBeNull();
  });

  it.each([
    ["an expired state", stored({ expiresAt: NOW })],
    ["a state with no expiry", stored({ expiresAt: undefined })],
    ["an expiry that is not a number", stored({ expiresAt: String(NOW + 600_000) })],
    ["no verifier", stored({ codeVerifier: undefined })],
    ["no nonce", stored({ idTokenNonce: undefined })],
    ["something other than JSON", "not json"],
    ["a JSON list", "[]"],
    ["JSON null", "null"],
  ])("refuses %s", (_label, value) => {
    expect(parseStoredState(value, NOW)).toBeNull();
  });
});

describe("verifiedCookieValue", () => {
  const secret = randomBytes(32).toString("base64url");
  const sign = (value: string, key = secret) =>
    encodeURIComponent(`${value}.${createHmac("sha256", key).update(value).digest("base64")}`);
  const state = "Abc_DEF-ghi".padEnd(32, "x");

  it("reads a value signed with the realm's secret, the first cookie of the name winning", () => {
    expect(verifiedCookieValue(`__Host-fin.state=${sign(state)}`, "__Host-fin.state", secret)).toBe(
      state,
    );
    expect(
      verifiedCookieValue(
        `other=1; __Host-fin.state=${sign(state)}; __Host-fin.state=${sign("second")}`,
        "__Host-fin.state",
        secret,
      ),
    ).toBe(state);
  });

  it.each([
    ["no cookie header", null],
    ["no cookie of the name", `__Host-fin.session_token=${sign(state)}`],
    ["a signature under another secret", `__Host-fin.state=${sign(state, "x".repeat(40))}`],
    ["a changed value", `__Host-fin.state=${sign(state).replace("Abc", "Abd")}`],
    ["a made-up signature", `__Host-fin.state=${state}.forged`],
    ["no signature", `__Host-fin.state=${state}`],
    ["an empty value", `__Host-fin.state=${sign("")}`],
    ["a bad encoding", "__Host-fin.state=%E0%A4%A"],
    ["a signature of the wrong length", `__Host-fin.state=${state}.${"A".repeat(42)}==`],
  ])("refuses %s", (_label, header) => {
    expect(verifiedCookieValue(header, "__Host-fin.state", secret)).toBeNull();
  });
});

describe("stateIdentifier", () => {
  it("names the library's verification row for a state", () => {
    expect(stateIdentifier("abc")).toBe("auth-state:abc");
  });
});
