import { ConfigError } from "@fin/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { isErrorsDsn } from "../report-dsn.ts";
import { baseEnv, randomProof } from "../testing/capture.ts";
import {
  loadAccessConfig,
  loadDocsOrigin,
  loadIngressConfig,
  loadProcessConfig,
  readEnv,
  refuseForbidden,
} from "./index.ts";
import { checkSeams, SEAM_VARIABLES } from "./seams.ts";

function configError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error("expected a ConfigError");
}

const dsn = (): string =>
  ["https://", "a".repeat(24), "@s1.eu-nbg-2.betterstackdata.com/123"].join("");

describe("loadProcessConfig", () => {
  it("reads the process variables", () => {
    const config = loadProcessConfig(baseEnv("console", { RAILWAY_REPLICA_ID: "r1" }), isErrorsDsn);
    expect(config).toMatchObject({
      service: "console",
      environment: "ci",
      drainSeconds: 40,
      port: 8080,
      replica: "r1",
      container: false,
      telemetry: undefined,
    });
  });

  it("names a missing variable and never its value", () => {
    const env = baseEnv("console");
    delete env.FIN_RELEASE;
    const error = configError(() => loadProcessConfig(env, isErrorsDsn));
    expect(error.variable).toBe("FIN_RELEASE");
    expect(error.problem).toBe("missing");
  });

  it("names a malformed variable and never its value", () => {
    const secret = "not-a-sha-but-a-secret-value";
    const error = configError(() =>
      loadProcessConfig(baseEnv("console", { FIN_RELEASE: secret }), isErrorsDsn),
    );
    expect(error.variable).toBe("FIN_RELEASE");
    expect(error.problem).toBe("malformed");
    expect(error.message).not.toContain(secret);
    for (const [name, value] of [
      ["FIN_ENVIRONMENT", "prod"],
      ["FIN_DRAIN_SECONDS", "abc"],
      ["FIN_DRAIN_SECONDS", "1"],
      ["PORT", "99999"],
      ["FIN_SERVICE", "nope"],
      ["FIN_CONTAINER", "yes"],
    ] as const) {
      expect(
        configError(() => loadProcessConfig(baseEnv("console", { [name]: value }), isErrorsDsn))
          .variable,
      ).toBe(name);
    }
  });

  it("refuses a service the entry does not run", () => {
    const error = configError(() => loadProcessConfig(baseEnv("admin"), isErrorsDsn, ["console"]));
    expect(error).toMatchObject({ variable: "FIN_SERVICE", problem: "refused" });
  });

  it("refuses development inside a container", () => {
    const env = baseEnv("console", { FIN_ENVIRONMENT: "development", FIN_CONTAINER: "1" });
    expect(configError(() => loadProcessConfig(env, isErrorsDsn)).variable).toBe("FIN_ENVIRONMENT");
  });

  it("requires the telemetry source and the Errors DSN when deployed", () => {
    const env = baseEnv("console", { FIN_ENVIRONMENT: "staging" });
    expect(configError(() => loadProcessConfig(env, isErrorsDsn)).variable).toBe(
      "FIN_TELEMETRY_HOST",
    );
    const token = "t".repeat(24);
    const full = {
      ...env,
      FIN_TELEMETRY_HOST: "s1.eu-nbg-2.betterstackdata.com",
      FIN_TELEMETRY_TOKEN: token,
    };
    expect(configError(() => loadProcessConfig(full, isErrorsDsn)).variable).toBe("FIN_ERRORS_DSN");
    const ok = loadProcessConfig({ ...full, FIN_ERRORS_DSN: dsn() }, isErrorsDsn);
    expect(ok.telemetry).toEqual({ host: "s1.eu-nbg-2.betterstackdata.com", token });
  });

  it("refuses a DSN outside Better Stack's shape", () => {
    const env = baseEnv("console", { FIN_ERRORS_DSN: "https://key@sentry.example.com/1" });
    expect(configError(() => loadProcessConfig(env, isErrorsDsn))).toMatchObject({
      variable: "FIN_ERRORS_DSN",
      problem: "malformed",
    });
  });

  it("refuses half a telemetry source", () => {
    const env = baseEnv("console", { FIN_TELEMETRY_TOKEN: "t".repeat(24) });
    expect(configError(() => loadProcessConfig(env, isErrorsDsn)).variable).toBe(
      "FIN_TELEMETRY_HOST",
    );
  });

  it("treats an empty value as missing", () => {
    expect(
      configError(() => readEnv({ FIN_RELEASE: z.string() }, { FIN_RELEASE: "" })).problem,
    ).toBe("missing");
  });
});

describe("loadIngressConfig", () => {
  const proofs = (roles: string[]) =>
    JSON.stringify(Object.fromEntries(roles.map((r) => [r, [randomProof(), randomProof()]])));
  /** A JSON object's text with a `__proto__` member added, which JSON.stringify never writes. */
  const withProtoKey = (json: string, value: unknown): string =>
    `${json.slice(0, -1)},"__proto__":${JSON.stringify(value)}}`;

  it("reads one origin, the connector services and the proofs", () => {
    const config = loadIngressConfig(
      {
        FIN_PUBLIC_ORIGIN: "https://console.example.net",
        FIN_CONNECTOR_SERVICES: "cloudflared-public,cloudflared-public-b",
        FIN_INGRESS_PROOFS: proofs(["console"]),
      },
      "staging",
      ["console"],
    );
    expect(config.origins).toEqual({ console: "https://console.example.net" });
    expect(config.connectorServices).toEqual(["cloudflared-public", "cloudflared-public-b"]);
    expect(config.proofs.console).toHaveLength(2);
  });

  it("refuses a role spelled __proto__, which a record would drop without a word", () => {
    const origins = withProtoKey(
      JSON.stringify({
        verify: "https://verify.example.net",
        selfie: "https://selfie.example.net",
      }),
      "https://other.example.net",
    );
    expect(
      configError(() =>
        loadIngressConfig(
          {
            FIN_PUBLIC_ORIGIN: origins,
            FIN_CONNECTOR_SERVICES: "cloudflared-public",
            FIN_INGRESS_PROOFS: proofs(["verify", "selfie"]),
          },
          "staging",
          ["verify", "selfie"],
        ),
      ),
    ).toMatchObject({ variable: "FIN_PUBLIC_ORIGIN", problem: "malformed" });
    const proofsWithProto = withProtoKey(proofs(["console"]), ["a".repeat(43)]);
    expect(
      configError(() =>
        loadIngressConfig(
          {
            FIN_PUBLIC_ORIGIN: "https://console.example.net",
            FIN_CONNECTOR_SERVICES: "cloudflared-public",
            FIN_INGRESS_PROOFS: proofsWithProto,
          },
          "staging",
          ["console"],
        ),
      ),
    ).toMatchObject({ variable: "FIN_INGRESS_PROOFS", problem: "malformed" });
  });

  it("reads verify's JSON origin object for both of its hosts", () => {
    const config = loadIngressConfig(
      {
        FIN_PUBLIC_ORIGIN: JSON.stringify({
          verify: "https://verify.example.net",
          selfie: "https://selfie.example.net",
        }),
        FIN_CONNECTOR_SERVICES: "cloudflared-public",
        FIN_INGRESS_PROOFS: proofs(["verify", "selfie"]),
      },
      "staging",
      ["verify", "selfie"],
    );
    expect(Object.keys(config.origins).sort()).toEqual(["selfie", "verify"]);
  });

  it("refuses plain http when deployed, a path in an origin, a short proof and an unknown service", () => {
    const base = {
      FIN_PUBLIC_ORIGIN: "https://console.example.net",
      FIN_CONNECTOR_SERVICES: "cloudflared-public",
      FIN_INGRESS_PROOFS: proofs(["console"]),
    };
    expect(
      configError(() =>
        loadIngressConfig({ ...base, FIN_PUBLIC_ORIGIN: "http://console.example.net" }, "staging", [
          "console",
        ]),
      ),
    ).toMatchObject({ variable: "FIN_PUBLIC_ORIGIN", problem: "refused" });
    expect(
      loadIngressConfig({ ...base, FIN_PUBLIC_ORIGIN: "http://localhost:5173" }, "development", [
        "console",
      ]).origins.console,
    ).toBe("http://localhost:5173");
    // CI serves its journeys on loopback; any other host is https there too.
    for (const loopback of ["http://localhost:5173", "http://console.localhost:8080"]) {
      expect(
        loadIngressConfig({ ...base, FIN_PUBLIC_ORIGIN: loopback }, "ci", ["console"]).origins
          .console,
      ).toBe(loopback);
    }
    expect(
      loadIngressConfig({ ...base, FIN_PUBLIC_ORIGIN: "http://127.0.0.1:8080" }, "ci", ["console"])
        .origins.console,
    ).toBe("http://127.0.0.1:8080");
    expect(
      configError(() =>
        loadIngressConfig({ ...base, FIN_PUBLIC_ORIGIN: "http://console.example.net" }, "ci", [
          "console",
        ]),
      ),
    ).toMatchObject({ variable: "FIN_PUBLIC_ORIGIN", problem: "refused" });
    expect(
      configError(() =>
        loadIngressConfig(
          {
            ...base,
            FIN_PUBLIC_ORIGIN: JSON.stringify({
              verify: "https://verify.example.net",
              selfie: "http://selfie.example.net",
            }),
            FIN_INGRESS_PROOFS: proofs(["verify", "selfie"]),
          },
          "ci",
          ["verify", "selfie"],
        ),
      ),
    ).toMatchObject({ variable: "FIN_PUBLIC_ORIGIN", problem: "refused" });
    expect(
      configError(() => loadDocsOrigin({ FIN_DOCS_ORIGIN: "http://docs.example.net" }, "ci")),
    ).toMatchObject({ variable: "FIN_DOCS_ORIGIN", problem: "refused" });
    expect(
      configError(() =>
        loadIngressConfig(
          { ...base, FIN_PUBLIC_ORIGIN: "https://console.example.net/app" },
          "staging",
          ["console"],
        ),
      ).variable,
    ).toBe("FIN_PUBLIC_ORIGIN");
    expect(
      configError(() =>
        loadIngressConfig(
          { ...base, FIN_INGRESS_PROOFS: JSON.stringify({ console: ["short"] }) },
          "staging",
          ["console"],
        ),
      ).variable,
    ).toBe("FIN_INGRESS_PROOFS");
    expect(
      configError(() =>
        loadIngressConfig({ ...base, FIN_INGRESS_PROOFS: "{not json" }, "staging", ["console"]),
      ).problem,
    ).toBe("malformed");
    expect(
      configError(() =>
        loadIngressConfig({ ...base, FIN_INGRESS_PROOFS: proofs(["admin"]) }, "staging", [
          "console",
        ]),
      ).variable,
    ).toBe("FIN_INGRESS_PROOFS");
    expect(
      configError(() =>
        loadIngressConfig({ ...base, FIN_CONNECTOR_SERVICES: "postgres" }, "staging", ["console"]),
      ).variable,
    ).toBe("FIN_CONNECTOR_SERVICES");
  });
});

describe("the other settings", () => {
  it("reads Access's team and audience", () => {
    expect(
      loadAccessConfig({ FIN_ACCESS_TEAM: "fin-team", FIN_ACCESS_AUD: "a1".repeat(32) }),
    ).toEqual({ team: "fin-team", aud: "a1".repeat(32) });
    expect(
      configError(() =>
        loadAccessConfig({
          FIN_ACCESS_TEAM: "https://x.example.com",
          FIN_ACCESS_AUD: "a".repeat(64),
        }),
      ).variable,
    ).toBe("FIN_ACCESS_TEAM");
  });

  it("reads the docs origin", () => {
    expect(loadDocsOrigin({ FIN_DOCS_ORIGIN: "https://docs.example.net" }, "staging")).toBe(
      "https://docs.example.net",
    );
    expect(configError(() => loadDocsOrigin({}, "staging")).variable).toBe("FIN_DOCS_ORIGIN");
  });

  it("refuses the settings that must never be set", () => {
    expect(
      configError(() => refuseForbidden({ BETTER_AUTH_TRUSTED_ORIGINS: "https://x.example.com" }))
        .variable,
    ).toBe("BETTER_AUTH_TRUSTED_ORIGINS");
    expect(configError(() => refuseForbidden({ NODE_OPTIONS: "--inspect" })).variable).toBe(
      "NODE_OPTIONS",
    );
    expect(() => refuseForbidden({})).not.toThrow();
  });
});

describe("seams (AC-P0-13)", () => {
  it("refuses every seam variable in a release build, naming it", () => {
    for (const name of SEAM_VARIABLES) {
      expect(
        configError(() => checkSeams({ ...baseEnv("console"), [name]: "1" }, "release")).variable,
      ).toBe(name);
    }
    expect(configError(() => checkSeams({ FIN_SEAM_ANYTHING_NEW: "" }, "release")).variable).toBe(
      "FIN_SEAM_ANYTHING_NEW",
    );
    expect(() =>
      checkSeams(baseEnv("console", { FIN_ENVIRONMENT: "staging" }), "release"),
    ).not.toThrow();
  });

  it("refuses a seam variable in any case and with any name, always as a ConfigError", () => {
    for (const name of ["FIN_SEAM_clock", "FIN_SEAM_X.Y", "fin_seam_clock", "Fin_Seam_Clock"]) {
      const error = configError(() =>
        checkSeams({ ...baseEnv("console"), [name]: "1" }, "release"),
      );
      expect(error, name).toMatchObject({ variable: "FIN_SEAM", problem: "refused" });
    }
  });

  it("refuses a test build in staging or production", () => {
    for (const environment of ["staging", "production"]) {
      expect(configError(() => checkSeams({ FIN_ENVIRONMENT: environment }, "test")).variable).toBe(
        "FIN_ENVIRONMENT",
      );
    }
    expect(() => checkSeams({ FIN_ENVIRONMENT: "ci", FIN_SEAM_CLOCK: "1" }, "test")).not.toThrow();
  });
});
