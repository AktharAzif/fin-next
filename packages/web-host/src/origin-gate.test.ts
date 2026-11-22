// spec 01 §4.4's gate, check by check and in its order.
import { describe, expect, it } from "vitest";
import { type GateRequest, gateDecision, hasBody } from "./origin-gate.ts";

const EXPECTED = { origin: "https://console.example.net", app: "console" };
const GOOD: GateRequest = {
  method: "POST",
  origin: "https://console.example.net",
  secFetchSite: "same-origin",
  finApp: "console",
  contentType: "application/json",
  hasBody: true,
  upload: false,
};

const decide = (patch: Partial<GateRequest>) => gateDecision({ ...GOOD, ...patch }, EXPECTED);

describe("gateDecision", () => {
  it("passes a same-origin JSON POST from the app", () => {
    expect(decide({})).toBeUndefined();
    expect(decide({ secFetchSite: undefined })).toBeUndefined();
    expect(decide({ contentType: "application/json; charset=utf-8" })).toBeUndefined();
    for (const method of ["PUT", "PATCH", "DELETE"]) expect(decide({ method })).toBeUndefined();
  });

  it("never gates GET, HEAD or OPTIONS", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(
        decide({ method, origin: undefined, finApp: undefined, contentType: "text/plain" }),
      ).toBeUndefined();
    }
  });

  it("check 1: Origin present, not null, and exact", () => {
    expect(decide({ origin: undefined })).toBe("origin_missing");
    expect(decide({ origin: "null" })).toBe("origin_missing");
    expect(decide({ origin: "" })).toBe("origin_missing");
    for (const origin of [
      "https://evil.example.com",
      "https://admin.example.net",
      "http://console.example.net",
      "https://console.example.net:443",
      "https://console.example.net/",
      "https://CONSOLE.example.net",
      "https://console.example.net.evil.example.com",
    ]) {
      expect(decide({ origin }), origin).toBe("origin_mismatch");
    }
  });

  it("check 2: Sec-Fetch-Site, when present, is same-origin", () => {
    for (const site of ["same-site", "cross-site", "none", ""]) {
      expect(decide({ secFetchSite: site }), site).toBe("fetch_site");
    }
  });

  it("check 3: X-Fin-App is the app's name", () => {
    expect(decide({ finApp: undefined })).toBe("app_header");
    expect(decide({ finApp: "admin" })).toBe("app_header");
    expect(decide({ finApp: "Console" })).toBe("app_header");
  });

  it("check 4: JSON bodies only, uploads where the policy names them, nothing else on a body-less request", () => {
    for (const contentType of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/jsonp",
      undefined,
    ]) {
      expect(decide({ contentType }), String(contentType)).toBe("content_type");
    }
    expect(
      decide({ contentType: "multipart/form-data; boundary=x", upload: true }),
    ).toBeUndefined();
    expect(decide({ hasBody: false, contentType: undefined })).toBeUndefined();
    expect(decide({ hasBody: false, contentType: "application/json" })).toBeUndefined();
    expect(decide({ hasBody: false, contentType: "text/plain" })).toBe("content_type");
  });

  it("applies the checks in order: the first failing check is the code", () => {
    expect(
      decide({
        origin: undefined,
        secFetchSite: "cross-site",
        finApp: undefined,
        contentType: "text/plain",
      }),
    ).toBe("origin_missing");
    expect(
      decide({ secFetchSite: "cross-site", finApp: undefined, contentType: "text/plain" }),
    ).toBe("fetch_site");
    expect(decide({ finApp: undefined, contentType: "text/plain" })).toBe("app_header");
  });
});

describe("hasBody", () => {
  const body = (init: Record<string, string>) => hasBody(new Headers(init));

  it("sees no body without Content-Length and Transfer-Encoding, or with a length of 0", () => {
    expect(body({})).toBe(false);
    expect(body({ "content-type": "application/json" })).toBe(false);
    expect(body({ "content-length": "0" })).toBe(false);
    expect(body({ "content-length": " 0 " })).toBe(false);
    expect(body({ "content-length": "" })).toBe(false);
  });

  it("sees a body with a positive Content-Length or any Transfer-Encoding", () => {
    expect(body({ "content-length": "2" })).toBe(true);
    expect(body({ "content-length": "00" })).toBe(true);
    expect(body({ "transfer-encoding": "chunked" })).toBe(true);
    expect(body({ "transfer-encoding": "gzip, chunked" })).toBe(true);
    expect(body({ "transfer-encoding": "chunked", "content-length": "0" })).toBe(true);
  });
});
