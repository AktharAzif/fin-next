// The environment of each session, built from nothing (spec 07 §4.3), and the refusal of the
// engine's own environment.
//
// Trimmed Phase 0 (docs/review/README.md): there is no fin-review OS user and no token of its own,
// so a session runs under the current user's Claude Code login. HOME is therefore the engine's own
// (a scratch home would drop the login). Under the `direct` transport CLAUDE_CODE_OAUTH_TOKEN is
// passed on when the engine has one, and CLAUDE_CONFIG_DIR never is: config/env-refusals.json
// refuses it, so a session's configuration is $HOME/.claude, inside the home whose other entries the
// settings deny, and whose settings files the engine checks before any session. Under the `pool`
// transport (src/transport.ts, decision BD-22) exactly ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and
// CLAUDE_CONFIG_DIR are passed in place of the login, each as the transport checked it, and
// CLAUDE_CODE_OAUTH_TOKEN never is. Everything else is fixed here; nothing else reaches a session.

import { checkEnvironment } from "../env-refusals.ts";
import { ConfigError } from "../errors.ts";
import type { EnvRefusals, EnvironmentRefusal } from "../env-refusals.ts";
import { DIRECT, withoutTransportVariables } from "../transport.ts";
import type { Transport } from "../transport.ts";

/** The names a session's environment may hold under the direct transport, and nothing else (T-RV-09). */
export const SESSION_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
  "DISABLE_AUTOUPDATER",
];

/** The names a session's environment holds under the pool transport, and nothing else. */
export const POOL_SESSION_ENV_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
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
export function sessionEnv(engineEnv: Readonly<Record<string, string | undefined>>, tmpDir: string, transport: Transport = DIRECT): Record<string, string> {
  if (!ABSOLUTE_RE.test(tmpDir)) throw new TypeError("the session's TMPDIR must be an absolute path");
  const env: Record<string, string> = {
    PATH: SESSION_PATH,
    HOME: engineHome(engineEnv),
    LANG: "C.UTF-8",
    TMPDIR: tmpDir,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
  };
  if (transport.kind === "pool") {
    env["ANTHROPIC_BASE_URL"] = transport.baseUrl;
    env["ANTHROPIC_AUTH_TOKEN"] = transport.authToken;
    env["CLAUDE_CONFIG_DIR"] = transport.configDir;
    return env;
  }
  if (engineEnv["CLAUDE_CONFIG_DIR"] !== undefined) {
    throw new ConfigError("CLAUDE_CONFIG_DIR", ["is refused (config/env-refusals.json): a session's configuration is $HOME/.claude"]);
  }
  const token = engineEnv["CLAUDE_CODE_OAUTH_TOKEN"];
  if (token !== undefined && token !== "") {
    if (!TOKEN_RE.test(token)) throw new ConfigError("CLAUDE_CODE_OAUTH_TOKEN", ["is not a token"]);
    env["CLAUDE_CODE_OAUTH_TOKEN"] = token;
  }
  return env;
}

/**
 * The refused variables in the engine's own environment (exit 78 before any session). Under the
 * pool transport, its three variables are not refused: the transport has already checked them.
 */
export function environmentRefusals(env: Readonly<Record<string, string | undefined>>, refusals: EnvRefusals, transport: Transport = DIRECT): EnvironmentRefusal[] {
  return checkEnvironment(withoutTransportVariables(env, transport), refusals);
}
