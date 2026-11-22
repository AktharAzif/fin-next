import { ConfigError } from "@fin/core";
import { TEST_RELEASE } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { loadConnectorConfig } from "./config.ts";

const token = (): string => `eyJhIjoi${"Q".repeat(40)}+/${"z".repeat(20)}==`;

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    FIN_SERVICE: "cloudflared-admin",
    FIN_ENVIRONMENT: "ci",
    FIN_RELEASE: TEST_RELEASE,
    FIN_DRAIN_SECONDS: "35",
    FIN_TUNNEL_ROLE: "admin",
    FIN_ZONE: "staging.example.net",
    FIN_TUNNEL_HOSTS: JSON.stringify({ admin: "staff.staging.example.net" }),
    FIN_ACCESS_TEAM: "fin-team",
    FIN_ACCESS_AUD: "b".repeat(64),
    TUNNEL_TOKEN: token(),
    ...extra,
  };
}

function refusal(values: Record<string, string | undefined>): string {
  try {
    loadConnectorConfig(values);
    return "ok";
  } catch (error) {
    if (error instanceof ConfigError) return `${error.variable}:${error.problem}`;
    throw error;
  }
}

describe("loadConnectorConfig", () => {
  it("reads the admin connector's settings", () => {
    const config = loadConnectorConfig(env());
    expect(config).toMatchObject({
      service: "cloudflared-admin",
      tunnel: "admin",
      zone: "staging.example.net",
      hosts: { admin: "staff.staging.example.net" },
      access: { team: "fin-team", aud: "b".repeat(64) },
      port: 8080,
      drainSeconds: 35,
      cloudflaredPath: "/usr/local/bin/cloudflared",
    });
    expect(config.token).toBe(token());
  });

  it("refuses each bad setting by name", () => {
    expect(refusal(env({ TUNNEL_TOKEN: undefined }))).toBe("TUNNEL_TOKEN:missing");
    expect(refusal(env({ TUNNEL_TOKEN: "not-a-token" }))).toBe("TUNNEL_TOKEN:malformed");
    expect(refusal(env({ FIN_TUNNEL_ROLE: "db" }))).toBe("FIN_TUNNEL_ROLE:malformed");
    expect(refusal(env({ FIN_TUNNEL_ROLE: "public" }))).toBe("FIN_TUNNEL_ROLE:refused");
    expect(refusal(env({ FIN_SERVICE: "cloudflared-db", FIN_TUNNEL_ROLE: "admin" }))).toBe(
      "FIN_TUNNEL_ROLE:refused",
    );
    expect(refusal(env({ FIN_ZONE: "Not A Zone" }))).toBe("FIN_ZONE:malformed");
    expect(refusal(env({ FIN_TUNNEL_HOSTS: "[]" }))).toBe("FIN_TUNNEL_HOSTS:malformed");
    expect(refusal(env({ FIN_TUNNEL_HOSTS: "{" }))).toBe("FIN_TUNNEL_HOSTS:malformed");
    expect(refusal(env({ FIN_ACCESS_AUD: undefined }))).toBe("FIN_ACCESS_AUD:missing");
    expect(refusal(env({ FIN_ENVIRONMENT: "staging" }))).toBe("FIN_TELEMETRY_HOST:missing");
    expect(refusal(env({ FIN_ENVIRONMENT: "development", FIN_CONTAINER: "1" }))).toBe(
      "FIN_ENVIRONMENT:refused",
    );
    expect(refusal(env({ FIN_CLOUDFLARED_PATH: "cloudflared" }))).toBe(
      "FIN_CLOUDFLARED_PATH:malformed",
    );
    expect(refusal(env({ FIN_DRAIN_SECONDS: "0" }))).toBe("FIN_DRAIN_SECONDS:malformed");
  });

  it("never puts a value in the error", () => {
    try {
      loadConnectorConfig(env({ TUNNEL_TOKEN: "secret-but-wrong-shape" }));
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("secret-but-wrong-shape");
    }
  });
});
