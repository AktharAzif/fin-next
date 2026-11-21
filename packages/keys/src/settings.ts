// The keys settings a service reads once inside main() (spec 05 §4.1, §4.2; spec 08 §6): FIN_KEY_SALT,
// which must be the salt of the process's FIN_ENVIRONMENT (a staging edge never accepts a production
// key, a staging console never makes one), and the pepper family API_KEY_PEPPER_<n> with
// API_KEY_PEPPER_IN_USE (32 bytes each, base64url), held by the edge, the console and the worker
// only. A missing or malformed value refuses the start with a ConfigError naming the variable, never
// its value (exit 78).
import { ConfigError } from "@fin/core";
import { type Keyring, KeyringConfigError, keyringFromEnv } from "@fin/crypto";
import { type KeyEnvironment, saltFor } from "./salts.ts";

export interface KeySettings {
  salt: string;
  peppers: Keyring;
}

export function keySettingsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  environment: KeyEnvironment,
): KeySettings {
  const salt = env.FIN_KEY_SALT;
  if (salt === undefined || salt === "") throw new ConfigError("FIN_KEY_SALT", "missing");
  if (salt !== saltFor(environment)) throw new ConfigError("FIN_KEY_SALT", "refused");
  try {
    return { salt, peppers: keyringFromEnv(env, "API_KEY_PEPPER") };
  } catch (error) {
    if (error instanceof KeyringConfigError) throw new ConfigError(error.variable, "malformed");
    throw error;
  }
}

/** Whether neither setting is present (a development or CI process may then run without keys). */
export function keySettingsAbsent(env: Readonly<Record<string, string | undefined>>): boolean {
  const empty = (v: string | undefined) => v === undefined || v === "";
  return empty(env.FIN_KEY_SALT) && empty(env.API_KEY_PEPPER_IN_USE);
}
