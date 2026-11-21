// Credential files (spec 01 §9.1, AGENTS.md §7). A credential reaches `pnpm fin` only as a file
// whose path an environment variable names; the file is read inside the process, the value is
// registered with the masker at once, and it lives on only as a Secret. Nothing here prints a value
// or a path's contents, and an error names the variable, never the file's text.

import { lstatSync, readFileSync } from "node:fs";
import { ConfigError } from "./errors.ts";
import type { Masker } from "./mask.ts";
import { Secret } from "./secret.ts";

/** The environment variables that may name a credential file, and what each one is. */
export const CREDENTIAL_VARIABLES = {
  FIN_CF_TOKEN_FILE: "the Cloudflare operator token (CR-05)",
  FIN_CF_STATIC_TOKEN_FILE: "the Cloudflare static deploy token (CR-20)",
  FIN_RAILWAY_TOKEN_FILE: "the Railway staging project token (CR-04)",
  FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE: "the Better Stack Telemetry API token (CR-09)",
  FIN_BETTERSTACK_UPTIME_TOKEN_FILE: "the Better Stack Uptime API token (CR-09)",
  FIN_OPS_INGEST_TOKEN_FILE: "the ingest token of the Better Stack source fin-next-<env>-ops",
} as const;

export type CredentialVariable = keyof typeof CREDENTIAL_VARIABLES;

export type Env = Readonly<Record<string, string | undefined>>;

/**
 * Reads the credential a variable names. The file must be a regular file (not a link), readable
 * by its owner only, and hold one line with no inner whitespace.
 */
export function readCredential(env: Env, variable: CredentialVariable, masker: Masker): Secret {
  const path = env[variable];
  const what = CREDENTIAL_VARIABLES[variable];
  if (path === undefined || path === "") {
    throw new ConfigError(`${variable} is not set: it names the file that holds ${what}`);
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ConfigError(`${variable} names a file that does not exist`);
  }
  if (!stat.isFile()) throw new ConfigError(`${variable} must name a regular file, not a link`);
  if ((stat.mode & 0o077) !== 0) {
    throw new ConfigError(
      `${variable} names a file that others can read; restrict it to its owner (chmod 600)`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new ConfigError(`${variable} names a file that cannot be read`);
  }
  const value = text.replace(/\r?\n$/, "");
  if (value.trim() === "") throw new ConfigError(`${variable} names an empty file`);
  if (/\s/.test(value)) {
    throw new ConfigError(`${variable} names a file whose value holds whitespace or a second line`);
  }
  masker.register(value, `<${variable.replace(/_FILE$/, "").toLowerCase()}>`);
  return new Secret(value);
}

/** Whether a variable names a file at all (for commands whose credential is optional). */
export function hasCredential(env: Env, variable: CredentialVariable): boolean {
  const path = env[variable];
  return path !== undefined && path !== "";
}
