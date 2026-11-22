import { describe, expect, it } from "vitest";
import { EmailConfigError, readEmailConfig } from "./config.ts";

// Values are built at run time: no token-, account- or key-shaped literal in the repository.
const KEY = Buffer.alloc(32, 9).toString("base64url");
const ENV: Record<string, string> = {
  FIN_ENVIRONMENT: "staging",
  FIN_RELEASE: "ab".repeat(20),
  FIN_EMAIL_TOKEN: ["token", "for", "the", "config", "test"].join("-"),
  FIN_EMAIL_ACCOUNT_ID: "cd".repeat(16),
  FIN_EMAIL_FROM: "account-security@auth.example.com",
  FIN_EMAIL_NOTIFY_FROM: "team@notify.example.com",
  FIN_EMAIL_LINK_ORIGINS: JSON.stringify({
    console: "https://console.example.com",
    admin: "https://staff.example.com",
  }),
  FIN_SEED_INBOX: "seed@example.net",
  FIN_LIMIT_KEY_IN_USE: "2",
  FIN_LIMIT_KEY_2: KEY,
  FIN_HEARTBEAT_EMAIL_DELIVERY_CHECK_URL: "https://heartbeat.example.com/ping",
};

function errorOf(env: Record<string, string | undefined>): EmailConfigError {
  try {
    readEmailConfig(env);
  } catch (error) {
    if (error instanceof EmailConfigError) return error;
    throw error;
  }
  throw new Error("expected EmailConfigError");
}

describe("readEmailConfig", () => {
  it("reads every email setting", () => {
    const config = readEmailConfig(ENV);
    expect(config).toMatchObject({
      environment: "staging",
      authFrom: "account-security@auth.example.com",
      notifyFrom: "team@notify.example.com",
      links: { console: "https://console.example.com", admin: "https://staff.example.com" },
      seedInbox: "seed@example.net",
      heartbeatUrl: "https://heartbeat.example.com/ping",
    });
    expect(config.limitKey.version).toBe(2);
    expect(config.limitKey.secret.byteLength).toBe(32);
    expect(Object.keys(config.links)).toEqual(["console", "admin"]);
  });

  it("leaves the notify sender and the heartbeat optional", () => {
    const { FIN_EMAIL_NOTIFY_FROM: _n, FIN_HEARTBEAT_EMAIL_DELIVERY_CHECK_URL: _h, ...rest } = ENV;
    const config = readEmailConfig(rest);
    expect(config.notifyFrom).toBeUndefined();
    expect(config.heartbeatUrl).toBeUndefined();
  });

  it("names every bad variable and never its value", () => {
    const error = errorOf({
      ...ENV,
      FIN_EMAIL_TOKEN: undefined,
      FIN_EMAIL_FROM: "account-security@notify.example.com",
      FIN_EMAIL_LINK_ORIGINS: JSON.stringify({ console: "http://console.example.com" }),
      FIN_LIMIT_KEY_2: "short",
    });
    expect(error.variables).toEqual([
      "FIN_EMAIL_TOKEN",
      "FIN_EMAIL_FROM",
      "FIN_EMAIL_LINK_ORIGINS",
      "FIN_LIMIT_KEY_2",
    ]);
    expect(error.message).not.toContain("example.com");
    expect(error.message).not.toContain("short");
  });

  it("refuses a notify sender off its subdomain, a bad account ID and a non-JSON link map", () => {
    expect(errorOf({ ...ENV, FIN_EMAIL_NOTIFY_FROM: "team@auth.example.com" }).variables).toEqual([
      "FIN_EMAIL_NOTIFY_FROM",
    ]);
    expect(errorOf({ ...ENV, FIN_EMAIL_ACCOUNT_ID: "nope" }).variables).toEqual([
      "FIN_EMAIL_ACCOUNT_ID",
    ]);
    expect(errorOf({ ...ENV, FIN_EMAIL_LINK_ORIGINS: "{" }).variables).toEqual([
      "FIN_EMAIL_LINK_ORIGINS",
    ]);
    expect(
      errorOf({ ...ENV, FIN_EMAIL_LINK_ORIGINS: JSON.stringify({ shop: "https://x.example.com" }) })
        .variables,
    ).toEqual(["FIN_EMAIL_LINK_ORIGINS"]);
  });
});
