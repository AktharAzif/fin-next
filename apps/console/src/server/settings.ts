// The console API half's own settings, read once inside main() (never at module scope), each refused
// at start-up with a ConfigError naming the variable (exit 78, `config.invalid`):
//   - the developer realm (spec 02 §3.2): FIN_PUBLIC_ORIGIN, BETTER_AUTH_SECRETS, FIN_LIMIT_KEY_<n>,
//     read by packages/identity, with the process's environment named as the realm names it;
//   - the database login (spec 01 §6.6): FIN_DB_HOST, FIN_DB_PORT, FIN_DB_NAME, FIN_DB_USER (one of
//     the console's own logins), FIN_DB_PASSWORD and FIN_DB_CA_PEM; TLS with the CA is required
//     except to a loopback database in development or CI.
import { ConfigError } from "@fin/core";
import { type RealmSettings, readRealmSettings } from "@fin/identity";
import type { Env, Environment } from "@fin/server/config";
import pg, { type Pool } from "pg";

/** The realm's name for the process's environment (the realm says `test` where the platform says `ci`). */
export function realmEnvironment(
  environment: Environment,
): "development" | "test" | "staging" | "production" {
  return environment === "ci" ? "test" : environment;
}

const VARIABLE = /^([A-Z][A-Z0-9_]*)\b/;

export function realmSettings(env: Env, environment: Environment): RealmSettings {
  try {
    return readRealmSettings("developer", {
      ...env,
      FIN_ENVIRONMENT: realmEnvironment(environment),
    });
  } catch (error) {
    // The realm names the variable first in its message; the value is never part of it.
    const named = error instanceof Error ? VARIABLE.exec(error.message)?.[1] : undefined;
    throw new ConfigError(named ?? "BETTER_AUTH_SECRETS", "malformed");
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const HOST = /^[A-Za-z0-9.-]{1,253}$|^[0-9a-fA-F:]{2,39}$/;

export interface PoolSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: false | { ca: string; servername: string; rejectUnauthorized: true };
}

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") throw new ConfigError(name, "missing");
  return value;
}

export function poolSettings(env: Env, environment: Environment): PoolSettings {
  const host = required(env, "FIN_DB_HOST").trim();
  if (!HOST.test(host)) throw new ConfigError("FIN_DB_HOST", "malformed");
  const portText = env.FIN_DB_PORT?.trim() ?? "5432";
  const port = Number(portText);
  if (!/^\d{1,5}$/.test(portText) || port < 1 || port > 65_535) {
    throw new ConfigError("FIN_DB_PORT", "malformed");
  }
  const database = required(env, "FIN_DB_NAME").trim();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) throw new ConfigError("FIN_DB_NAME", "malformed");
  const user = required(env, "FIN_DB_USER").trim();
  // Only the console's own logins (fin_console_a, fin_console_b): never another service's.
  if (!/^fin_console_[a-z]$/.test(user)) throw new ConfigError("FIN_DB_USER", "refused");
  const password = required(env, "FIN_DB_PASSWORD");
  const ca = env.FIN_DB_CA_PEM;
  let ssl: PoolSettings["ssl"];
  if (ca !== undefined && ca.trim() !== "") {
    ssl = { ca, servername: host, rejectUnauthorized: true };
  } else if ((environment === "development" || environment === "ci") && LOOPBACK.has(host)) {
    ssl = false;
  } else {
    throw new ConfigError("FIN_DB_CA_PEM", "missing");
  }
  return { host, port, database, user, password, ssl };
}

/** The console's pool (spec 01 §6.6's sizes): one unit of work per request, never across I/O. */
export function createConsolePool(settings: PoolSettings): Pool {
  const pool = new pg.Pool({
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    ssl: settings.ssl,
    application_name: "console",
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 1_800,
    query_timeout: 20_000,
  });
  return pool;
}
