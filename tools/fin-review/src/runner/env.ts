// The environment of each session, built from nothing (spec 07 §4.3), and the refusal of the
// engine's own environment.
//
// Trimmed Phase 0 (docs/review/README.md): there is no fin-review OS user and no token of its own,
// so a session runs under the current user's Claude Code login. HOME and CLAUDE_CONFIG_DIR are
// therefore the engine's own (a scratch home would drop the login), and CLAUDE_CODE_OAUTH_TOKEN is
// passed on when the engine has one. Everything else is fixed here; nothing else reaches a session.

import { checkEnvironment } from "../env-refusals.ts";
import { ConfigError } from "../errors.ts";
import type { EnvRefusals, EnvironmentRefusal } from "../env-refusals.ts";

/** The names a session's environment may hold, and nothing else (T-RV-09). */
export const SESSION_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
];

export const SESSION_PATH = "/usr/bin:/bin";

const ABSOLUTE_RE = /^\/[^\0\n]*$/;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/** The engine's HOME, which sessions keep in the trimmed Phase 0. Throws when it is unusable. */
export function engineHome(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["HOME"];
  if (home === undefined || !ABSOLUTE_RE.test(home) || home.split("/").includes("..")) {
    throw new ConfigError("HOME", ["must be set to an absolute path"]);
  }
  return home;
}

/**
 * A session's whole environment. `tmpDir` is the session's own scratch directory (created empty
 * for each attempt and deleted after it).
 */
export function sessionEnv(engineEnv: Readonly<Record<string, string | undefined>>, tmpDir: string): Record<string, string> {
  if (!ABSOLUTE_RE.test(tmpDir)) throw new TypeError("the session's TMPDIR must be an absolute path");
  const env: Record<string, string> = {
    PATH: SESSION_PATH,
    HOME: engineHome(engineEnv),
    LANG: "C.UTF-8",
    TMPDIR: tmpDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  const configDir = engineEnv["CLAUDE_CONFIG_DIR"];
  if (configDir !== undefined && configDir !== "") {
    if (!ABSOLUTE_RE.test(configDir)) throw new ConfigError("CLAUDE_CONFIG_DIR", ["must be an absolute path"]);
    env["CLAUDE_CONFIG_DIR"] = configDir;
  }
  const token = engineEnv["CLAUDE_CODE_OAUTH_TOKEN"];
  if (token !== undefined && token !== "") {
    if (!TOKEN_RE.test(token)) throw new ConfigError("CLAUDE_CODE_OAUTH_TOKEN", ["is not a token"]);
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token;
  }
  return env;
}

/** The refused variables in the engine's own environment (exit 78 before any session). */
export function environmentRefusals(env: Readonly<Record<string, string | undefined>>, refusals: EnvRefusals): EnvironmentRefusal[] {
  return checkEnvironment(env, refusals);
}

/** The refusal lines printed on stderr: names and kinds only, never values. */
export function refusalLines(found: readonly EnvironmentRefusal[]): string[] {
  return found.map((item) => `fin-review: environment_refused: ${item.name} (${item.kind}) is set; unset it to run sessions ([RV-19])`);
}
