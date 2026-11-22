// The process's pg pool (ARCHITECTURE §3.5, §4.5; DECISIONS P-12, P-18).
//
// TLS is verify-full against the pinned CA (`FIN_DB_CA_PEM`) with the server name set in code, never in
// a URL: pg 8.23 reads `sslmode=require` in a URL as verify-full and would let a URL change the
// policy, so Fin never builds a connection from a URL. Authentication is SCRAM only: a server that
// asks for a cleartext or MD5 password is refused before any password is sent (the runner's rule,
// applied to every Fin connection), and channel binding is on whenever TLS is.
import { z } from "zod";
import type { LineSink } from "./context.ts";
import { DatabaseConfigError } from "./errors.ts";
import { Client, type PgPool, Pool, type PoolConfig } from "./pg.ts";
import { POOL_BUDGET, type ServiceName } from "./roles.ts";

export class InsecureAuthenticationError extends Error {
  override readonly name = "InsecureAuthenticationError";
  constructor(method: string) {
    super(`the server asked for ${method} authentication; only SCRAM-SHA-256 is accepted`);
  }
}

/** A pg client that refuses cleartext and MD5 password authentication. */
export class ScramOnlyClient extends Client {
  protected override _handleAuthCleartextPassword(_message: unknown): void {
    this.connection.emit("error", new InsecureAuthenticationError("cleartext"));
  }
  protected override _handleAuthMD5Password(_message: unknown): void {
    this.connection.emit("error", new InsecureAuthenticationError("MD5"));
  }
}

export type TlsSettings =
  | { caPem: string; servername: string }
  /** Only for the loopback test database (CI's service container, a developer's compose). */
  | { insecureLoopback: true };

export interface ConnectionSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  tls: TlsSettings;
  applicationName: string;
}

export interface PoolSettings extends ConnectionSettings {
  max: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  maxLifetimeSeconds?: number;
  queryTimeoutMillis?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/** The pg client options for a connection, TLS included. Exported for the TLS settings test. */
export function clientConfig(settings: ConnectionSettings): PoolConfig {
  if ("insecureLoopback" in settings.tls) {
    if (!LOOPBACK.has(settings.host)) {
      throw new DatabaseConfigError(
        "FIN_DB_HOST",
        "TLS may be off only for a loopback test database",
      );
    }
  } else if (!settings.tls.caPem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new DatabaseConfigError("FIN_DB_CA_PEM", "must be a PEM certificate");
  }
  const tls =
    "insecureLoopback" in settings.tls
      ? false
      : {
          ca: settings.tls.caPem,
          servername: settings.tls.servername,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2" as const,
        };
  return {
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    password: settings.password,
    application_name: settings.applicationName,
    ssl: tls,
    enableChannelBinding: tls !== false,
    keepAlive: true,
  };
}

export function createPool(settings: PoolSettings, log: LineSink): PgPool {
  const pool = new Pool({
    ...clientConfig(settings),
    Client: ScramOnlyClient,
    max: settings.max,
    connectionTimeoutMillis: settings.connectionTimeoutMillis ?? 5_000,
    idleTimeoutMillis: settings.idleTimeoutMillis ?? 30_000,
    maxLifetimeSeconds: settings.maxLifetimeSeconds ?? 1_800,
    query_timeout: settings.queryTimeoutMillis ?? 20_000,
  });
  // An idle client's error would otherwise crash the process; it is a line instead (spec 01 §8.9).
  pool.on("error", (error) => {
    log.write({
      event: "database.pool_error",
      level: "error",
      fields: { code: errorCode(error) },
    });
  });
  return pool;
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  return error instanceof Error ? error.name : "unknown";
}

const envSchema = z.object({
  FIN_DB_HOST: z.string().regex(/^[A-Za-z0-9.-]{1,253}$|^[0-9a-fA-F:]{2,39}$/),
  FIN_DB_PORT: z
    .string()
    .regex(/^[1-9][0-9]{0,4}$/)
    .transform(Number)
    .refine((port) => port <= 65_535),
  FIN_DB_NAME: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/),
  FIN_DB_USER: z.string().regex(/^fin_(edge|api|worker|payments|console|admin)_[ab]$/),
  FIN_DB_PASSWORD: z.string().min(16).max(256),
  FIN_DB_CA_PEM: z.string().optional(),
  FIN_ENVIRONMENT: z.enum(["development", "ci", "staging", "production"]),
});

/**
 * The pool settings of a service from its environment (spec 01 §6.7), validated; called once from
 * `main()`. A missing or malformed variable throws DatabaseConfigError naming it (exit 78), never
 * its value. TLS may be off only in development or CI against a loopback host.
 */
export function poolSettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  service: ServiceName,
): PoolSettings {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const variable = String(parsed.error.issues[0]?.path[0] ?? "FIN_DB_*");
    throw new DatabaseConfigError(variable, "is missing or malformed");
  }
  const e = parsed.data;
  if (!e.FIN_DB_USER.startsWith(`fin_${service}_`)) {
    throw new DatabaseConfigError("FIN_DB_USER", `is not one of ${service}'s logins`);
  }
  let tls: TlsSettings;
  if (e.FIN_DB_CA_PEM !== undefined && e.FIN_DB_CA_PEM !== "") {
    tls = { caPem: e.FIN_DB_CA_PEM, servername: e.FIN_DB_HOST };
  } else if (
    (e.FIN_ENVIRONMENT === "development" || e.FIN_ENVIRONMENT === "ci") &&
    LOOPBACK.has(e.FIN_DB_HOST)
  ) {
    tls = { insecureLoopback: true };
  } else {
    throw new DatabaseConfigError("FIN_DB_CA_PEM", "is required outside a loopback test database");
  }
  return {
    host: e.FIN_DB_HOST,
    port: e.FIN_DB_PORT,
    database: e.FIN_DB_NAME,
    user: e.FIN_DB_USER,
    password: e.FIN_DB_PASSWORD,
    tls,
    applicationName: `fin-${service}`,
    max: POOL_BUDGET[service].max,
  };
}
