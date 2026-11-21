// Start-up refusals that need no dependency (Node built-ins and @fin/core only), so every Fin
// process runs them first: runService and the connector supervisor alike.
//
// Test seams never ship (ARCHITECTURE §3.5, [SA-38], AC-P0-13). The server bundle is built for one
// target, compiled in by Vite's `define` from FIN_BUILD_TARGET (vite.server.config.ts):
//   - `release` refuses to start (exit 78) when any FIN_SEAM_* variable is set, naming it;
//   - `test` (and source runs under Vitest) refuses to start in staging or production.
// CI's `seams` job starts every release image with each variable of SEAM_VARIABLES set and
// expects exit 78.
//
// Settings that must never be set (spec 02 §2.6; ARCHITECTURE §3.5) are refused here too.
import { ConfigError } from "@fin/core";
import type { Env } from "./index.ts";

declare const __FIN_BUILD_TARGET__: string | undefined;

export type BuildTarget = "release" | "test" | "source";

/** The seams the test target may switch on; each is a FIN_SEAM_* variable. */
export const SEAM_VARIABLES = [
  "FIN_SEAM_CLOCK",
  "FIN_SEAM_EMAIL_SINK",
  "FIN_SEAM_ACCESS_STANDIN",
  "FIN_SEAM_PROVIDER_STANDINS",
  "FIN_SEAM_RELAXED_LIMITS",
  "FIN_SEAM_TEST_INGRESS",
] as const;

export const SEAM_PREFIX = "FIN_SEAM_";

/** The name a refusal gives a seam variable whose own name is not an environment variable's. */
export const SEAM_FAMILY = "FIN_SEAM";

const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Settings refused at boot: the command carries Node's flags (no NODE_OPTIONS), and Better Auth's
 * trusted origins and base URL come from code, exactly the app's origin.
 */
export const FORBIDDEN_VARIABLES = [
  "BETTER_AUTH_TRUSTED_ORIGINS",
  "BETTER_AUTH_URL",
  "NODE_OPTIONS",
] as const;

/** The target this code was built for. */
export function buildTarget(): BuildTarget {
  const target = typeof __FIN_BUILD_TARGET__ === "string" ? __FIN_BUILD_TARGET__ : "source";
  return target === "release" || target === "test" ? target : "source";
}

/**
 * Refuses a seam in a release build, and a test build in a deployed environment. Any variable
 * whose name starts with FIN_SEAM_, in any case, is a seam: a release never starts with one, and
 * always exits 78, naming it when it can.
 */
export function checkSeams(env: Env, target: BuildTarget = buildTarget()): void {
  if (target === "release") {
    const set = Object.keys(env)
      .filter((name) => name.toUpperCase().startsWith(SEAM_PREFIX) && env[name] !== undefined)
      .sort();
    const first = set[0];
    if (first !== undefined) {
      throw new ConfigError(VARIABLE_NAME.test(first) ? first : SEAM_FAMILY, "refused");
    }
    return;
  }
  const environment = env.FIN_ENVIRONMENT;
  if (environment === "staging" || environment === "production") {
    throw new ConfigError("FIN_ENVIRONMENT", "refused");
  }
}

/** Refuses the settings that must never be set. */
export function refuseForbidden(env: Env): void {
  for (const name of FORBIDDEN_VARIABLES) {
    if (env[name] !== undefined && env[name] !== "") throw new ConfigError(name, "refused");
  }
}
