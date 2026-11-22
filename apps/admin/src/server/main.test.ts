// Fin Admin's start (ARCHITECTURE §3.5): a refused setting of the staff realm or the pool stops the
// start with exit 78 and a `config.invalid` line naming the variable, never its value; the process's
// `ci` environment is the realm's `test`.
import { runService } from "@fin/server";
import { baseEnv } from "@fin/server/testing";
import { describe, expect, it } from "vitest";
import { adminService, asConfigError, realmEnv } from "./main.ts";

const random = (bytes: number) =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

function env(overrides: Record<string, string | undefined>): Record<string, string> {
  const all: Record<string, string | undefined> = {
    ...baseEnv("admin", { FIN_DRAIN_SECONDS: "5" }),
    FIN_DOCS_ORIGIN: "https://docs.example.net",
    FIN_PUBLIC_ORIGIN: "https://staff.example.net",
    FIN_CONNECTOR_SERVICES: "cloudflared-admin",
    FIN_INGRESS_PROOFS: JSON.stringify({ admin: [random(32)] }),
    FIN_ACCESS_TEAM: "fin-team",
    FIN_ACCESS_AUD: "e".repeat(64),
    BETTER_AUTH_SECRETS: `2:${random(32)},1:${random(32)}`,
    FIN_LIMIT_KEY_1: "ab".repeat(32),
    FIN_DB_HOST: "127.0.0.1",
    FIN_DB_PORT: "5432",
    FIN_DB_NAME: "fin",
    FIN_DB_USER: "fin_admin_a",
    FIN_DB_PASSWORD: random(24),
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function start(overrides: Record<string, string | undefined>) {
  const exits: number[] = [];
  const stdout: Record<string, unknown>[] = [];
  const secret = overrides.FIN_DB_PASSWORD;
  const service = await runService(adminService, {
    env: env(overrides),
    exit: (code) => exits.push(code),
    processHandlers: false,
    host: "::",
    port: 0,
    stdout: (text) => stdout.push(JSON.parse(text) as Record<string, unknown>),
    resolve: async () => [{ address: "127.0.0.1", family: 4 }],
  });
  if (service !== undefined) await service.shutdown.begin("SIGTERM");
  return { exits, stdout, secret };
}

describe("Fin Admin's start", () => {
  it("refuses a missing realm secret with exit 78, naming the variable", async () => {
    const { exits, stdout } = await start({ BETTER_AUTH_SECRETS: undefined });
    expect(exits).toEqual([78]);
    expect(stdout.find((l) => l.event === "config.invalid")).toMatchObject({
      variable: "BETTER_AUTH_SECRETS",
    });
  });

  it("refuses a pool login of another service, naming the variable and never the value", async () => {
    const { exits, stdout } = await start({ FIN_DB_USER: "fin_console_a" });
    expect(exits).toEqual([78]);
    expect(stdout.find((l) => l.event === "config.invalid")).toMatchObject({
      variable: "FIN_DB_USER",
    });
    expect(JSON.stringify(stdout)).not.toContain("fin_console_a");
  });

  it("starts with every setting present, and stops cleanly", async () => {
    const { exits, stdout } = await start({});
    expect(exits).toEqual([0]);
    expect(stdout.some((l) => l.event === "process.start")).toBe(true);
  });

  it("reads the process's ci as the realm's test, and nothing else changes", () => {
    expect(realmEnv({ FIN_ENVIRONMENT: "ci", X: "y" })).toEqual({
      FIN_ENVIRONMENT: "test",
      X: "y",
    });
    expect(realmEnv({ FIN_ENVIRONMENT: "staging" }).FIN_ENVIRONMENT).toBe("staging");
  });

  it("maps only the realm's and the pool's setting errors", () => {
    const realm = Object.assign(new Error("no FIN_LIMIT_KEY_<n> is set"), {
      name: "RealmConfigError",
    });
    expect(asConfigError(realm)).toMatchObject({
      variable: "FIN_LIMIT_KEY_1",
      problem: "malformed",
    });
    const pool = Object.assign(new Error("FIN_DB_PORT: bad"), {
      name: "DatabaseConfigError",
      variable: "FIN_DB_PORT",
    });
    expect(asConfigError(pool)).toMatchObject({ variable: "FIN_DB_PORT" });
    const other = new Error("boom");
    expect(asConfigError(other)).toBe(other);
  });
});
