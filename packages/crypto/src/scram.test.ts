import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateDatabasePassword,
  isScramVerifier,
  parseScramVerifier,
  ScramVerifierError,
  scramKeys,
  scramSha256Verifier,
} from "./scram.ts";

describe("SCRAM-SHA-256 verifiers", () => {
  it("derives RFC 7677's keys: the client proof and server signature of its exchange", () => {
    const salt = new Uint8Array(Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
    const { clientKey, storedKey, serverKey } = scramKeys("pencil", salt, 4096);
    const authMessage = [
      "n=user,r=rOprNGfwEbeRWgbNEkqO",
      "r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096",
      "c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0",
    ].join(",");
    const signature = createHmac("sha256", storedKey).update(authMessage).digest();
    const proof = Buffer.from(clientKey.map((byte, i) => byte ^ (signature[i] ?? 0)));
    expect(proof.toString("base64")).toBe("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=");
    expect(createHmac("sha256", serverKey).update(authMessage).digest("base64")).toBe(
      "6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=",
    );
  });

  it("writes Postgres's stored form and reads it back", () => {
    const salt = new Uint8Array(Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
    const verifier = scramSha256Verifier("pencil", { salt });
    expect(verifier).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
    const parsed = parseScramVerifier(verifier);
    expect(parsed.iterations).toBe(4096);
    expect(parsed.salt).toEqual(salt);
    expect(isScramVerifier(verifier)).toBe(true);
  });

  it("refuses anything that is not a verifier, a plaintext password first of all", () => {
    for (const bad of [
      "pencil",
      generateDatabasePassword(),
      `md5${"0".repeat(32)}`,
      "SCRAM-SHA-256$4096:short$abc:def",
      "SCRAM-SHA-256$100:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU= ",
    ]) {
      expect(isScramVerifier(bad)).toBe(false);
      expect(() => parseScramVerifier(bad)).toThrow(ScramVerifierError);
    }
  });

  it("makes a different salt each time and 43-character base64url passwords", () => {
    expect(scramSha256Verifier("x-pass")).not.toBe(scramSha256Verifier("x-pass"));
    const password = generateDatabasePassword();
    expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => scramSha256Verifier("has space")).toThrow(ScramVerifierError);
  });
});
