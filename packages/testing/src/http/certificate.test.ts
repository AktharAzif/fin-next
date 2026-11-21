import { createPrivateKey, X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { selfSignedIdentity } from "./certificate.ts";

const NOW = Date.parse("2026-11-21T08:00:00Z");

describe("selfSignedIdentity", () => {
  const identity = selfSignedIdentity(["console.localhost", "localhost", "127.0.0.1", "::1"], {
    now: NOW,
  });
  const x509 = new X509Certificate(identity.cert);

  it("makes a certificate Node's own parser reads, signed by its own key", () => {
    expect(x509.verify(x509.publicKey)).toBe(true);
    expect(x509.checkPrivateKey(createPrivateKey(identity.key))).toBe(true);
    expect(x509.subject).toBe("CN=fin-next test host");
    expect(x509.issuer).toBe(x509.subject);
    expect(x509.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
  });

  it("names every host, as DNS names and IP addresses", () => {
    expect(x509.subjectAltName).toBe(
      "DNS:console.localhost, DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1",
    );
    expect(x509.checkHost("console.localhost")).toBe("console.localhost");
    expect(x509.checkHost("admin.localhost")).toBeUndefined();
    expect(x509.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(x509.checkIP("::1")).toBe("::1");
  });

  it("is a server certificate and not a CA, valid from a day before now for 30 days", () => {
    expect(x509.ca).toBe(false);
    expect(x509.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(Date.parse(x509.validFrom)).toBe(NOW - 86_400_000);
    expect(Date.parse(x509.validTo)).toBe(NOW + 30 * 86_400_000);
  });

  it("writes GeneralizedTime from 2050 on", () => {
    const later = new X509Certificate(
      selfSignedIdentity(["localhost"], { now: Date.parse("2049-12-25T00:00:00Z"), days: 30 }).cert,
    );
    expect(later.validTo).toContain("2050");
  });

  it("makes a new key and serial each time", () => {
    const other = new X509Certificate(selfSignedIdentity(["console.localhost"]).cert);
    expect(other.serialNumber).not.toBe(x509.serialNumber);
    expect(other.fingerprint256).not.toBe(x509.fingerprint256);
    expect(/^[0-7]/.test(x509.serialNumber)).toBe(true);
  });

  it("refuses what a certificate cannot name", () => {
    for (const bad of ["", "has space.localhost", "-x.localhost", "300.0.0.1", "a..b", "::2"]) {
      expect(() => selfSignedIdentity([bad])).toThrow();
    }
    expect(() => selfSignedIdentity([])).toThrow("at least one");
    expect(() => selfSignedIdentity(["localhost"], { days: 0 })).toThrow("days");
  });
});
