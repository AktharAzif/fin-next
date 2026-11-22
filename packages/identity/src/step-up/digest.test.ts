// T-SAT-07: RFC 8785 canonical JSON and the intent digest's known answers; NFC and lower-casing;
// only the bound fields count.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CanonicalJsonError, canonicalJson, digestDocument, paramsDigest } from "./digest.ts";

describe("canonicalJson", () => {
  it("sorts keys by UTF-16 code units and writes no whitespace (RFC 8785 §3.2.3)", () => {
    expect(canonicalJson({ b: 1, a: [true, null, "x"], "€": 0, "\u0080": 1, A: {} })).toBe(
      '{"A":{},"a":[true,null,"x"],"b":1,"\u0080":1,"€":0}',
    );
  });

  it("escapes strings as RFC 8785 does", () => {
    expect(canonicalJson('a"b\\c\n\u0001')).toBe('"a\\"b\\\\c\\n\\u0001"');
    expect(canonicalJson("é")).toBe('"é"');
  });

  it("writes integers plainly and -0 as 0", () => {
    expect(canonicalJson([0, -0, 1, -42, 9007199254740991])).toBe("[0,0,1,-42,9007199254740991]");
  });

  it.each([[1.5], [Number.NaN], [2 ** 60], [new Date(0)], [undefined], [() => 1]])(
    "refuses %s",
    (value) => {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    },
  );

  it("drops undefined members of an object", () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe('{"b":2}');
  });
});

describe("the intent digest", () => {
  const base = {
    realm: "developer" as const,
    action: "member.invite",
    org: "org_01jdz7m7g4x3s6v9q2w8e5r1tb",
    target: null,
    bind: [
      { name: "email", kind: "address" as const },
      { name: "roleKey", kind: "string" as const },
    ],
  };

  it("has a known answer", () => {
    const document = digestDocument({
      ...base,
      body: { email: "Ada@Example.com", roleKey: "admin" },
    });
    expect(document).toBe(
      '{"action":"member.invite","org":"org_01jdz7m7g4x3s6v9q2w8e5r1tb","params":{"email":"ada@example.com","roleKey":"admin"},"realm":"developer","target":null}',
    );
    expect(paramsDigest({ ...base, body: { email: "Ada@Example.com", roleKey: "admin" } })).toEqual(
      createHash("sha256").update(document, "utf8").digest(),
    );
  });

  it("covers only the bound fields", () => {
    const a = paramsDigest({
      ...base,
      body: { email: "a@example.com", roleKey: "admin", note: "x" },
    });
    const b = paramsDigest({
      ...base,
      body: { email: "a@example.com", roleKey: "admin", note: "y" },
    });
    expect(a).toEqual(b);
    const c = paramsDigest({ ...base, body: { email: "a@example.com", roleKey: "viewer" } });
    expect(c).not.toEqual(a);
  });

  it("normalises bound strings to NFC and addresses to lower case", () => {
    const composed = paramsDigest({ ...base, body: { email: "a@example.com", roleKey: "Rôle" } });
    const decomposed = paramsDigest({
      ...base,
      body: { email: "A@EXAMPLE.COM ", roleKey: "Rôle" },
    });
    expect(decomposed).toEqual(composed);
  });

  it("sorts and deduplicates bound key lists", () => {
    const bind = [{ name: "permissions", kind: "keys" as const }];
    const a = paramsDigest({ ...base, bind, body: { permissions: ["b", "a", "a"] } });
    const b = paramsDigest({ ...base, bind, body: { permissions: ["a", "b"] } });
    expect(a).toEqual(b);
  });

  it("binds the realm, the action, the organisation and the target", () => {
    const body = { email: "a@example.com", roleKey: "admin" };
    const one = paramsDigest({ ...base, body });
    expect(paramsDigest({ ...base, body, realm: "staff" })).not.toEqual(one);
    expect(paramsDigest({ ...base, body, action: "invitation.change" })).not.toEqual(one);
    expect(paramsDigest({ ...base, body, org: null })).not.toEqual(one);
    expect(paramsDigest({ ...base, body, target: "inv_01jdz7m7g4x3s6v9q2w8e5r1tb" })).not.toEqual(
      one,
    );
  });

  it("refuses a bound field of the wrong type", () => {
    expect(() => paramsDigest({ ...base, body: { email: 7, roleKey: "admin" } })).toThrow(
      CanonicalJsonError,
    );
  });
});
