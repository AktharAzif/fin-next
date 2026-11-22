// Configuration (ARCHITECTURE §3.5; spec 01 §6.7). `process.env` is read once, in main(), and
// validated with Zod. A missing or malformed value throws a ConfigError that names the variable and
// never its value; main() turns it into exit code 78.
import { ConfigError } from "@fin/core";
import { z } from "zod";

export type Env = Readonly<Record<string, string | undefined>>;
export type EnvSpec = Readonly<Record<string, z.ZodType>>;
export type EnvValues<S extends EnvSpec> = { [K in keyof S]: z.output<S[K]> };

/**
 * Reads exactly the variables `spec` names. An empty value counts as missing. A schema that
 * accepts `undefined` (optional, or with a default) makes its variable optional.
 */
export function readEnv<S extends EnvSpec>(spec: S, env: Env): EnvValues<S> {
  const out: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(spec)) {
    const raw = env[name];
    const value = raw === undefined || raw === "" ? undefined : raw;
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new ConfigError(name, value === undefined ? "missing" : "malformed");
    out[name] = parsed.data;
  }
  return out as EnvValues<S>;
}

const PROTO_KEY = "__proto__";

/**
 * Parses a JSON variable, then validates it; a parse failure is "malformed". A `__proto__` key is
 * malformed too: a record schema would drop it silently, so a check for unknown keys would miss it.
 */
export function json<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>> {
  return z
    .string()
    .transform((text, ctx) => {
      try {
        return JSON.parse(text, (key, value: unknown) => {
          if (key === PROTO_KEY) throw new SyntaxError("a __proto__ key");
          return value;
        }) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "not JSON" });
        return z.NEVER;
      }
    })
    .pipe(schema) as unknown as z.ZodType<z.output<T>>;
}

export const ENVIRONMENTS = ["development", "ci", "staging", "production"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/** The service names of spec 08 §7.2's envelope. */
export const SERVICE_NAMES = [
  "edge",
  "api",
  "worker",
  "payments",
  "console",
  "admin",
  "verify",
  "migrate",
  "backup",
  "cloudflared-public",
  "cloudflared-public-b",
  "cloudflared-admin",
  "cloudflared-admin-b",
  "cloudflared-db",
  "watcher",
  "ops",
] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export const hostname = z.string().regex(HOSTNAME);

/** An origin: scheme, host and optional port, with no path, query, fragment or credentials. */
export const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
});

/** 32 random bytes in base64url without padding (spec 01 §6.7). */
export const proofValue = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A host role (spec 01 §7.3; the code names hosts by role, never by name). */
export const HOST_ROLES = ["api", "console", "admin", "verify", "selfie", "docs"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

/** The variables every Fin process reads (spec 01 §6.7, spec 08 §7.3). */
export const processVariables = {
  FIN_SERVICE: z.enum(SERVICE_NAMES),
  FIN_ENVIRONMENT: z.enum(ENVIRONMENTS),
  FIN_RELEASE: z.string().regex(/^[0-9a-f]{40}$/),
  FIN_DRAIN_SECONDS: z.coerce.number().int().min(5).max(600),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  FIN_TELEMETRY_HOST: hostname.optional(),
  FIN_TELEMETRY_TOKEN: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/)
    .optional(),
  FIN_ERRORS_DSN: z.string().max(512).optional(),
  FIN_CONTAINER: z.literal("1").optional(),
  // Railway's replica ID (SP-03 records the variable's name; UNVERIFIED).
  RAILWAY_REPLICA_ID: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
} satisfies EnvSpec;

export interface ProcessConfig {
  service: ServiceName;
  environment: Environment;
  release: string;
  drainSeconds: number;
  port: number;
  replica: string;
  container: boolean;
  telemetry: { host: string; token: string } | undefined;
  errorsDsn: string | undefined;
}

/** Whether Better Stack must be configured: everywhere a process is deployed. */
export function isDeployed(environment: Environment): boolean {
  return environment === "staging" || environment === "production";
}

/**
 * Reads the process variables and applies the rules across them: a container refuses
 * `development`; a deployed process needs its telemetry source and Errors DSN (spec 08 §7.3).
 */
export function loadProcessConfig(
  env: Env,
  validateDsn: (dsn: string) => boolean,
  expected?: readonly ServiceName[],
): ProcessConfig {
  const v = readEnv(processVariables, env);
  if (expected !== undefined && !expected.includes(v.FIN_SERVICE)) {
    throw new ConfigError("FIN_SERVICE", "refused");
  }
  if (v.FIN_CONTAINER === "1" && v.FIN_ENVIRONMENT === "development") {
    throw new ConfigError("FIN_ENVIRONMENT", "refused");
  }
  if (v.FIN_ERRORS_DSN !== undefined && !validateDsn(v.FIN_ERRORS_DSN)) {
    throw new ConfigError("FIN_ERRORS_DSN", "malformed");
  }
  if (isDeployed(v.FIN_ENVIRONMENT)) {
    for (const name of ["FIN_TELEMETRY_HOST", "FIN_TELEMETRY_TOKEN", "FIN_ERRORS_DSN"] as const) {
      if (v[name] === undefined) throw new ConfigError(name, "missing");
    }
  }
  if ((v.FIN_TELEMETRY_HOST === undefined) !== (v.FIN_TELEMETRY_TOKEN === undefined)) {
    throw new ConfigError(
      v.FIN_TELEMETRY_HOST === undefined ? "FIN_TELEMETRY_HOST" : "FIN_TELEMETRY_TOKEN",
      "missing",
    );
  }
  return {
    service: v.FIN_SERVICE,
    environment: v.FIN_ENVIRONMENT,
    release: v.FIN_RELEASE,
    drainSeconds: v.FIN_DRAIN_SECONDS,
    port: v.PORT,
    replica: v.RAILWAY_REPLICA_ID ?? "local",
    container: v.FIN_CONTAINER === "1",
    telemetry:
      v.FIN_TELEMETRY_HOST !== undefined && v.FIN_TELEMETRY_TOKEN !== undefined
        ? { host: v.FIN_TELEMETRY_HOST, token: v.FIN_TELEMETRY_TOKEN }
        : undefined,
    errorsDsn: v.FIN_ERRORS_DSN,
  };
}

/** A loopback host: `localhost` and its subdomains, 127.0.0.0/8, `[::1]`. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}

/**
 * Whether an origin may be plain http (ARCHITECTURE §3.5: https outside development). CI serves
 * its journeys on loopback, which browsers treat as secure, so CI may use http for a loopback
 * host and nothing else; staging and production never.
 */
export function plainHttpAllowed(value: string, environment: Environment): boolean {
  if (value.startsWith("https://")) return true;
  if (environment === "development") return true;
  return environment === "ci" && isLoopbackHost(new URL(value).hostname);
}

/** An origin variable: https, or http only in development and on loopback in CI. */
export function readOrigin(env: Env, name: string, environment: Environment): string {
  const value = readEnv({ [name]: origin }, env)[name] as string;
  if (!plainHttpAllowed(value, environment)) throw new ConfigError(name, "refused");
  return value;
}

/** What the ingress check needs (spec 01 §6.7: FIN_CONNECTOR_SERVICES, FIN_INGRESS_PROOFS). */
export interface IngressConfig {
  /** Host role to the public origin the service answers for. */
  origins: Partial<Record<HostRole, string>>;
  connectorServices: string[];
  /** Host role to its accepted proofs: [current] or [current, previous]. */
  proofs: Partial<Record<HostRole, string[]>>;
}

const connectorService = z.string().regex(/^cloudflared-[a-z0-9-]{1,50}$/);

/**
 * Reads FIN_PUBLIC_ORIGIN (one origin, or for verify a JSON object of role to origin), the
 * connector services and the ingress proofs, and checks that every role has both.
 */
export function loadIngressConfig(
  env: Env,
  environment: Environment,
  roles: readonly HostRole[],
): IngressConfig {
  const origins: Partial<Record<HostRole, string>> = {};
  if (roles.length === 1) {
    const role = roles[0] as HostRole;
    origins[role] = readOrigin(env, "FIN_PUBLIC_ORIGIN", environment);
  } else {
    const parsed = readEnv({ FIN_PUBLIC_ORIGIN: json(z.record(z.string(), origin)) }, env);
    for (const role of roles) {
      const value = parsed.FIN_PUBLIC_ORIGIN[role];
      if (value === undefined) throw new ConfigError("FIN_PUBLIC_ORIGIN", "malformed");
      if (!plainHttpAllowed(value, environment)) {
        throw new ConfigError("FIN_PUBLIC_ORIGIN", "refused");
      }
      origins[role] = value;
    }
    if (Object.keys(parsed.FIN_PUBLIC_ORIGIN).length !== roles.length) {
      throw new ConfigError("FIN_PUBLIC_ORIGIN", "malformed");
    }
  }
  const hosts = Object.values(origins).map((o) => new URL(o).host);
  if (new Set(hosts).size !== hosts.length) throw new ConfigError("FIN_PUBLIC_ORIGIN", "malformed");

  const v = readEnv(
    {
      FIN_CONNECTOR_SERVICES: z
        .string()
        .transform((s) => s.split(",").map((part) => part.trim()))
        .pipe(z.array(connectorService).min(1).max(4)),
      FIN_INGRESS_PROOFS: json(z.record(z.string(), z.array(proofValue).min(1).max(2))),
    },
    env,
  );
  const proofs: Partial<Record<HostRole, string[]>> = {};
  for (const role of roles) {
    const values = v.FIN_INGRESS_PROOFS[role];
    if (values === undefined) throw new ConfigError("FIN_INGRESS_PROOFS", "malformed");
    proofs[role] = values;
  }
  return { origins, connectorServices: v.FIN_CONNECTOR_SERVICES, proofs };
}

/** Fin Admin's Access settings (spec 01 §6.7, §7.7): the team name and the audience tag. */
export interface AccessConfig {
  team: string;
  aud: string;
}

export function loadAccessConfig(env: Env): AccessConfig {
  const v = readEnv(
    {
      FIN_ACCESS_TEAM: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/),
      FIN_ACCESS_AUD: z.string().regex(/^[A-Za-z0-9]{16,128}$/),
    },
    env,
  );
  return { team: v.FIN_ACCESS_TEAM, aud: v.FIN_ACCESS_AUD };
}

/** The docs origin that every problem document's `type` starts with (spec 05 §3.3). */
export function loadDocsOrigin(env: Env, environment: Environment): string {
  return readOrigin(env, "FIN_DOCS_ORIGIN", environment);
}

// The settings that must never be set are refused with the seams, in the module that needs no
// dependency, so the connector supervisor refuses them too.
export { FORBIDDEN_VARIABLES, refuseForbidden } from "./seams.ts";
