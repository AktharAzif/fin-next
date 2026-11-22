import { describe, expect, it, vi } from "vitest";
import { envSchema, isOrigin, loadEnv } from "../src/env/env.ts";

const good = {
  environment: "staging",
  release: "0123456789abcdef0123456789abcdef01234567",
  docsOrigin: "https://docs.example.com",
  consoleOrigin: "https://console.example.com",
};

function answer(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
  );
}

describe("isOrigin", () => {
  it("accepts bare https origins, and http only on loopback", () => {
    expect(isOrigin("https://console.example.com")).toBe(true);
    expect(isOrigin("https://console.example.com:8443")).toBe(true);
    expect(isOrigin("http://127.0.0.1:4173")).toBe(true);
    expect(isOrigin("http://localhost:4173")).toBe(true);
  });

  it("refuses paths, plain http elsewhere and other schemes", () => {
    expect(isOrigin("https://console.example.com/")).toBe(false);
    expect(isOrigin("https://console.example.com/x")).toBe(false);
    expect(isOrigin("http://console.example.com")).toBe(false);
    expect(isOrigin("javascript:alert(1)")).toBe(false);
    expect(isOrigin("not a url")).toBe(false);
  });
});

describe("loadEnv", () => {
  it("reads /env.json with no-cache and ignores unknown fields", async () => {
    const fetchImpl = answer({ ...good, extra: "ignored" });
    const result = await loadEnv(fetchImpl);
    expect(result).toEqual({ ok: true, env: good });
    expect(fetchImpl).toHaveBeenCalledWith(
      "/env.json",
      expect.objectContaining({ cache: "no-cache", credentials: "same-origin" }),
    );
  });

  it("keeps the API origin when it is there", async () => {
    const result = await loadEnv(answer({ ...good, apiOrigin: "https://gateway.example.com" }));
    expect(result.ok && result.env.apiOrigin).toBe("https://gateway.example.com");
  });

  it("fails closed on every kind of bad answer, without throwing", async () => {
    expect(await loadEnv(answer(good, 404))).toEqual({ ok: false, reason: "status" });
    expect(await loadEnv(answer("<html>"))).toEqual({ ok: false, reason: "not_json" });
    expect(await loadEnv(answer({ ...good, environment: "qa" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await loadEnv(answer({ ...good, release: "" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(await loadEnv(answer({ ...good, docsOrigin: "http://docs.example.com" }))).toEqual({
      ok: false,
      reason: "invalid",
    });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await loadEnv(offline)).toEqual({ ok: false, reason: "network" });
  });

  it("allows a plain-http loopback origin only in development and CI", () => {
    const loopback = {
      docsOrigin: "http://localhost:4000",
      consoleOrigin: "http://127.0.0.1:5173",
      apiOrigin: "http://[::1]:8080",
    };
    for (const environment of ["development", "ci"]) {
      expect(envSchema.safeParse({ ...good, ...loopback, environment }).success).toBe(true);
    }
    for (const environment of ["staging", "production"]) {
      expect(envSchema.safeParse({ ...good, ...loopback, environment }).success).toBe(false);
      for (const [field, value] of Object.entries(loopback)) {
        const parsed = envSchema.safeParse({ ...good, environment, [field]: value });
        expect(parsed.success, `${environment} ${field}`).toBe(false);
        expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([field]);
      }
    }
  });

  it("fails closed on a deployed env.json that names a plain-http origin", async () => {
    expect(
      await loadEnv(
        answer({ ...good, environment: "production", consoleOrigin: "http://localhost:5173" }),
      ),
    ).toEqual({ ok: false, reason: "invalid" });
  });

  it("names exactly the plan's fields (spec 01 §7.4)", () => {
    expect(Object.keys(envSchema.shape).sort()).toEqual(
      ["apiOrigin", "consoleOrigin", "docsOrigin", "environment", "release"].sort(),
    );
  });
});
