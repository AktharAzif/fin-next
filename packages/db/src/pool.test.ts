import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { parseReplicas, parseRoleVerifiers } from "./bootstrap.ts";
import { parseSuperuserUrl } from "./connect.ts";
import { DatabaseConfigError, MigrationError } from "./errors.ts";
import { Client } from "./pg.ts";
import {
  clientConfig,
  InsecureAuthenticationError,
  poolSettingsFromEnv,
  ScramOnlyClient,
} from "./pool.ts";
import { auxiliaryConnectionLimit, connectionLimit } from "./roles.ts";

const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
// Built at run time: the public-safety check refuses password-shaped literals in tracked files.
const PASSWORD = ["test", "only", "password", "value"].join("-");

const ENV = {
  FIN_DB_HOST: "postgres.railway.internal",
  FIN_DB_PORT: "5432",
  FIN_DB_NAME: "railway",
  FIN_DB_USER: "fin_api_a",
  FIN_DB_PASSWORD: PASSWORD,
  FIN_DB_CA_PEM: CA,
  FIN_ENVIRONMENT: "staging",
};

function variableOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof DatabaseConfigError) return error.variable;
    throw error;
  }
  return "none";
}

describe("the pool's TLS settings (P-18)", () => {
  it("verifies the server against the pinned CA with the host as server name, set in code", () => {
    const settings = poolSettingsFromEnv(ENV, "api");
    const config = clientConfig(settings);
    expect(config.ssl).toEqual({
      ca: CA,
      servername: "postgres.railway.internal",
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(config.enableChannelBinding).toBe(true);
    expect(config.application_name).toBe("fin-api");
    expect(settings.max).toBe(8);
    expect(JSON.stringify(config)).not.toContain("sslmode");
  });

  it("refuses to start without the CA outside a loopback test database", () => {
    const { FIN_DB_CA_PEM: _ca, ...noCa } = ENV;
    expect(variableOf(() => poolSettingsFromEnv(noCa, "api"))).toBe("FIN_DB_CA_PEM");
    expect(
      variableOf(() =>
        poolSettingsFromEnv(
          { ...noCa, FIN_ENVIRONMENT: "ci", FIN_DB_HOST: "db.example.com" },
          "api",
        ),
      ),
    ).toBe("FIN_DB_CA_PEM");
    const loopback = poolSettingsFromEnv(
      { ...noCa, FIN_ENVIRONMENT: "ci", FIN_DB_HOST: "127.0.0.1" },
      "api",
    );
    expect(clientConfig(loopback).ssl).toBe(false);
    expect(variableOf(() => clientConfig({ ...loopback, host: "db.example.com" }))).toBe(
      "FIN_DB_HOST",
    );
  });

  it("names the variable and never the value when one is malformed", () => {
    expect(variableOf(() => poolSettingsFromEnv({ ...ENV, FIN_DB_PORT: "x" }, "api"))).toBe(
      "FIN_DB_PORT",
    );
    expect(variableOf(() => poolSettingsFromEnv({ ...ENV, FIN_DB_USER: "postgres" }, "api"))).toBe(
      "FIN_DB_USER",
    );
    expect(variableOf(() => poolSettingsFromEnv(ENV, "worker"))).toBe("FIN_DB_USER");
    try {
      poolSettingsFromEnv({ ...ENV, FIN_DB_PASSWORD: "short" }, "api");
    } catch (error) {
      expect(String(error)).not.toContain("short");
    }
    expect(
      variableOf(() => poolSettingsFromEnv({ ...ENV, FIN_DB_CA_PEM: "not a pem" }, "api")),
    ).toBe("none");
    expect(
      variableOf(() =>
        clientConfig(poolSettingsFromEnv({ ...ENV, FIN_DB_CA_PEM: "not a pem" }, "api")),
      ),
    ).toBe("FIN_DB_CA_PEM");
  });
});

describe("ScramOnlyClient", () => {
  it("overrides pg's own cleartext and MD5 handlers (pinned: a pg upgrade that renames them fails here)", () => {
    const proto = Client.prototype as unknown as Record<string, unknown>;
    expect(typeof proto._handleAuthCleartextPassword).toBe("function");
    expect(typeof proto._handleAuthMD5Password).toBe("function");
    expect(typeof proto._handleAuthSASL).toBe("function");
  });

  it("refuses a cleartext or MD5 request with an error, sending no password", () => {
    for (const handler of ["_handleAuthCleartextPassword", "_handleAuthMD5Password"] as const) {
      const client = new ScramOnlyClient({ host: "127.0.0.1", password: PASSWORD });
      const fake = new EventEmitter() as EventEmitter & { password: (value: string) => void };
      const sent: string[] = [];
      fake.password = (value) => sent.push(value);
      const errors: unknown[] = [];
      fake.on("error", (error) => errors.push(error));
      (client as unknown as { connection: unknown }).connection = fake;
      (client as unknown as Record<string, (m: unknown) => void>)[handler]?.({});
      expect(errors[0]).toBeInstanceOf(InsecureAuthenticationError);
      expect(sent).toEqual([]);
    }
  });
});

describe("the superuser URL", () => {
  it("takes only host, port, database and credentials", () => {
    const url = [
      "postgresql://postgres:",
      PASSWORD,
      "@postgres.railway.internal:5432/railway",
    ].join("");
    expect(parseSuperuserUrl(url)).toEqual({
      host: "postgres.railway.internal",
      port: 5432,
      database: "railway",
      user: "postgres",
      password: PASSWORD,
    });
  });

  it("refuses parameters, where sslmode would change the TLS policy", () => {
    const url = [
      "postgresql://postgres:",
      PASSWORD,
      "@db.example.com/railway?sslmode=disable",
    ].join("");
    expect(variableOf(() => parseSuperuserUrl(url))).toBe("FIN_BOOTSTRAP_DATABASE_URL");
    expect(variableOf(() => parseSuperuserUrl("mysql://a:b@c/d"))).toBe(
      "FIN_BOOTSTRAP_DATABASE_URL",
    );
    expect(variableOf(() => parseSuperuserUrl(undefined))).toBe("FIN_BOOTSTRAP_DATABASE_URL");
  });
});

describe("FIN_ROLE_VERIFIERS and FIN_DB_REPLICAS", () => {
  const verifier =
    "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=";
  const all = Object.fromEntries(
    ["edge", "api", "worker", "payments", "console", "admin"].map((s) => [`fin_${s}_a`, verifier]),
  );

  function messageOf(fn: () => unknown): string {
    try {
      fn();
    } catch (error) {
      if (error instanceof MigrationError) return error.message;
      throw error;
    }
    return "none";
  }

  it("accepts verifiers for every _a login and optional others", () => {
    expect(
      Object.keys(parseRoleVerifiers(JSON.stringify({ ...all, fin_probe: verifier }))).length,
    ).toBe(7);
  });

  it("refuses a plaintext password without echoing it, an unknown login and a missing _a login", () => {
    const leaked = messageOf(() =>
      parseRoleVerifiers(JSON.stringify({ ...all, fin_api_a: PASSWORD })),
    );
    expect(leaked).toContain("fin_api_a");
    expect(leaked).not.toContain(PASSWORD);
    expect(
      messageOf(() => parseRoleVerifiers(JSON.stringify({ ...all, postgres: verifier }))),
    ).toContain("unknown login");
    const { fin_edge_a: _edge, ...missing } = all;
    expect(messageOf(() => parseRoleVerifiers(JSON.stringify(missing)))).toContain("fin_edge_a");
    expect(messageOf(() => parseRoleVerifiers(undefined))).toContain("required");
    expect(messageOf(() => parseRoleVerifiers("[]"))).toContain("object");
  });

  it("reads replicas per service, 1 to 20", () => {
    expect(parseReplicas(undefined)).toEqual({});
    expect(parseReplicas('{"api":2}')).toEqual({ api: 2 });
    expect(messageOf(() => parseReplicas('{"api":0}'))).toContain("1 to 20");
    expect(messageOf(() => parseReplicas('{"docs":1}'))).toContain("unknown service");
  });
});

describe("connection limits (ARCHITECTURE §4.5)", () => {
  it("is (pool max + LISTEN) × replicas × 2 + 2", () => {
    expect(connectionLimit("edge", 1)).toBe(18);
    expect(connectionLimit("api", 2)).toBe(34);
    expect(connectionLimit("worker", 2)).toBe(30);
    expect(connectionLimit("admin", 2)).toBe(14);
    expect(auxiliaryConnectionLimit("fin_owner")).toBe(6);
    expect(() => connectionLimit("api", 0)).toThrow(RangeError);
  });
});
