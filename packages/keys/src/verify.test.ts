// The edge's key check (spec 05 §4.7; T05-06's pepper chain; T05-08's reasons): every refusal reason,
// the pepper chain after a re-hash, a pepper the edge lacks, an unreadable expiry, a rolled key past
// its overlap, the allowlist, and the live gate. The key record is built as the view returns it.
import { randomBytes } from "node:crypto";
import { createKeyring, type Keyring } from "@fin/crypto";
import { describe, expect, it } from "vitest";
import { newKey } from "./generate.ts";
import { chainHash, hashForStorage, matchesStored, PepperMissingError, rehash } from "./hash.ts";
import { saltFor } from "./salts.ts";
import { bearerOf, judgeKey, type KeyRecord, liveGate, precheck } from "./verify.ts";

const salt = saltFor("ci");
const p1 = new Uint8Array(randomBytes(32));
const p2 = new Uint8Array(randomBytes(32));
const peppers = (inUse: number, versions: [number, Uint8Array][]): Keyring =>
  createKeyring("API_KEY_PEPPER", new Map(versions), inUse);
const one = peppers(1, [[1, p1]]);
const both = peppers(2, [
  [1, p1],
  [2, p2],
]);
const NOW = Date.parse("2026-11-22T10:00:00.000Z");

function record(key: ReturnType<typeof newKey>, over: Partial<KeyRecord> = {}): KeyRecord {
  const stored = hashForStorage(one, key.body);
  return {
    id: key.id,
    organization_id: "org_01jd0000000000000000000000",
    mode: key.key.startsWith("fin_live_") ? "live" : "test",
    kind: key.key.includes("_sk_") ? "sk" : "rk",
    scopes: key.key.includes("_sk_") ? [] : ["customers:read"],
    ip_allowlist: [],
    hash: Buffer.from(stored.hash),
    pepper_versions: stored.pepperVersions,
    expires_at: null,
    revoked_at: null,
    rolling_until: null,
    org_live_status: "not_enabled",
    ...over,
  };
}

function judge(key: ReturnType<typeof newKey>, rec: KeyRecord | null, clientIp = "8.8.8.8") {
  const pre = precheck(`Bearer ${key.key}`, salt);
  if (!pre.ok) throw new Error(pre.reason);
  return judgeKey({ key: pre.key, record: rec, peppers: one, now: NOW, clientIp });
}

describe("the bearer and its precheck", () => {
  it("reads exactly `Bearer <key>`, the scheme's name in any case (RFC 9110 §11.1)", () => {
    expect(bearerOf(undefined)).toBeNull();
    expect(bearerOf("")).toBeNull();
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer abc")).toBe("abc");
    expect(bearerOf("BEARER abc")).toBe("abc");
    expect(bearerOf("bEaReR abc")).toBe("abc");
    expect(bearerOf("Bearer  abc")).toBe("");
    expect(bearerOf("Bearer\tabc")).toBe("");
    expect(bearerOf(" Bearer abc")).toBe("");
    expect(bearerOf("Bearerabc")).toBe("");
    expect(bearerOf("Basic abc")).toBe("");
  });

  it("passes a working key sent with the scheme in lower case", () => {
    const key = newKey("test", "rk", salt);
    const pre = precheck(`bearer ${key.key}`, salt);
    expect(pre).toMatchObject({ ok: true, key: { id: key.id } });
  });

  it("refuses a missing, malformed, mistyped or other deployment's key before any lookup", () => {
    const key = newKey("test", "rk", salt);
    expect(precheck(undefined, salt)).toEqual({ ok: false, reason: "missing" });
    expect(precheck("Bearer nope", salt)).toEqual({ ok: false, reason: "malformed" });
    const flipped = `${key.key.slice(0, 59)}${key.key[59] === "0" ? "1" : "0"}`;
    expect(precheck(`Bearer ${flipped}`, salt)).toMatchObject({ ok: false });
    const staging = newKey("test", "rk", saltFor("staging"));
    expect(precheck(`Bearer ${staging.key}`, salt)).toEqual({
      ok: false,
      reason: "other_deployment",
    });
    expect(precheck(`Bearer ${key.key}`, salt)).toMatchObject({ ok: true });
  });
});

describe("judgeKey", () => {
  it("passes a working key with its organisation, mode, kind and scopes", () => {
    const key = newKey("test", "rk", salt);
    expect(judge(key, record(key))).toEqual({
      ok: true,
      key: {
        id: key.id,
        organizationId: "org_01jd0000000000000000000000",
        mode: "test",
        kind: "rk",
        scopes: ["customers:read"],
        orgLiveStatus: "not_enabled",
      },
    });
  });

  it.each([
    ["unknown (no record)", null, "unknown"],
    ["a record missing a field", { hash: null }, "unknown"],
    ["a wrong secret", { hash: Buffer.alloc(32, 7) }, "unknown"],
    ["revoked", { revoked_at: new Date(NOW - 1000) }, "revoked"],
    ["expired", { expires_at: new Date(NOW - 1) }, "expired"],
    ["an unreadable expiry", { expires_at: "soon" }, "expired"],
    ["rolled past its overlap", { rolling_until: new Date(NOW) }, "expired"],
    ["outside its allowlist", { ip_allowlist: ["8.8.4.0/24"] }, "ip_not_allowed"],
    ["a pepper the edge lacks", { pepper_versions: [1, 9] }, "pepper_missing"],
  ] as const)("refuses %s", (_label, over, reason) => {
    const key = newKey("test", "rk", salt);
    const rec = over === null ? null : record(key, over as Partial<KeyRecord>);
    expect(judge(key, rec)).toEqual({ ok: false, reason });
  });

  // Spec 05 §4.7: a record missing any field reads as unknown, never as "not revoked" or "never
  // expires" (a view or statement that lost a column).
  it.each([
    "revoked_at",
    "expires_at",
    "rolling_until",
    "org_live_status",
    "pepper_versions",
    "ip_allowlist",
  ] as const)("refuses a record with no %s as unknown, absent or undefined", (field) => {
    const key = newKey("test", "rk", salt);
    const { [field]: _dropped, ...absent } = record(key);
    expect(field in absent).toBe(false);
    expect(judge(key, absent as unknown as KeyRecord)).toEqual({ ok: false, reason: "unknown" });
    const undefinedField = record(key, { [field]: undefined } as Partial<KeyRecord>);
    expect(judge(key, undefinedField)).toEqual({ ok: false, reason: "unknown" });
  });

  it("reads any revoked_at but null as revoked", () => {
    const key = newKey("test", "rk", salt);
    for (const value of ["2026-11-22", 0, false, new Date(Number.NaN)]) {
      expect(judge(key, record(key, { revoked_at: value }))).toEqual({
        ok: false,
        reason: "revoked",
      });
    }
  });

  it("keeps a rolling key working until its overlap ends, and an allowlisted address through", () => {
    const key = newKey("test", "rk", salt);
    expect(judge(key, record(key, { rolling_until: new Date(NOW + 60_000) })).ok).toBe(true);
    expect(judge(key, record(key, { ip_allowlist: "{8.8.8.0/24}" })).ok).toBe(true);
    expect(judge(key, record(key, { expires_at: new Date(NOW + 1) })).ok).toBe(true);
  });

  it("refuses a record whose mode or kind is not the key's", () => {
    const key = newKey("test", "rk", salt);
    expect(judge(key, record(key, { mode: "live" }))).toEqual({ ok: false, reason: "unknown" });
    expect(judge(key, record(key, { kind: "sk", scopes: [] }))).toEqual({
      ok: false,
      reason: "unknown",
    });
  });
});

describe("the pepper chain (T05-06)", () => {
  it("verifies after a re-hash onto a newer pepper, without the secret", () => {
    const key = newKey("live", "sk", salt);
    const stored = hashForStorage(one, key.body);
    const moved = rehash(both, stored.hash, stored.pepperVersions);
    expect(moved.pepperVersions).toEqual([1, 2]);
    expect(matchesStored(both, key.body, moved.hash, moved.pepperVersions)).toBe(true);
    expect(matchesStored(both, key.body, stored.hash, stored.pepperVersions)).toBe(true);
    expect(Buffer.from(chainHash(both, key.body, [1, 2]))).toEqual(Buffer.from(moved.hash));
    // A second re-hash onto the same pepper changes nothing.
    expect(rehash(both, moved.hash, moved.pepperVersions)).toEqual(moved);
  });

  it("refuses a key whose chain names a pepper the edge does not hold", () => {
    const key = newKey("live", "sk", salt);
    const stored = hashForStorage(both, key.body);
    expect(stored.pepperVersions).toEqual([2]);
    expect(() => matchesStored(one, key.body, stored.hash, [2])).toThrow(PepperMissingError);
  });
});

describe("the live gate", () => {
  const verified = (
    mode: "test" | "live",
    orgLiveStatus: "not_enabled" | "enabled" | "paused",
  ) => ({
    id: "ABCDEFGHJK",
    organizationId: "org_01jd0000000000000000000000",
    mode,
    kind: "rk" as const,
    scopes: [],
    orgLiveStatus,
  });

  it("refuses a live key before go-live, while paused, and while the live_keys switch is on", () => {
    expect(liveGate(verified("live", "not_enabled"), false)).toBe("live_not_enabled");
    expect(liveGate(verified("live", "paused"), false)).toBe("live_paused");
    expect(liveGate(verified("live", "enabled"), true)).toBe("temporarily_unavailable");
    expect(liveGate(verified("live", "enabled"), false)).toBeNull();
  });

  it("never touches a Sandbox key", () => {
    expect(liveGate(verified("test", "not_enabled"), true)).toBeNull();
    expect(liveGate(verified("test", "paused"), true)).toBeNull();
  });
});
