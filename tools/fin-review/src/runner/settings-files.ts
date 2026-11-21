// The settings and configuration files a locked session's Claude Code could read (spec 07 §4.3),
// refused before any session when one sets something config/env-refusals.json refuses (exit 78,
// `settings_refused`), and by the doctor's D3.
//
// Which files, for the pinned 2.1.328 (read from the client itself on 21 Nov 2026). The session's
// configuration directory is $HOME/.claude under the direct transport (CLAUDE_CONFIG_DIR is refused
// there) and $CLAUDE_CONFIG_DIR under the pool transport (src/transport.ts). In it:
//
// - the user settings, `settings.json`. Sessions pass `--setting-sources ""`, which keeps them out;
//   this check is the second layer. Under pool, its `env` block may set ANTHROPIC_BASE_URL and
//   ANTHROPIC_AUTH_TOKEN to exactly the values the transport passes (the forwarder's own login),
//   which changes nothing; any other entry is refused;
// - the legacy global configuration, `.config.json`;
// - `remote-settings.json`, the client's cache of server-managed settings: the engine cannot tell
//   what they set, so a cached copy is refused. Server-managed settings that are not cached cannot
//   be read locally at all; D3 reports them as unknown.
//
// The global configuration, `.claude.json` in $HOME (direct) or in $CLAUDE_CONFIG_DIR (pool): the
// client applies its `env` object to its own environment at start, whatever `--setting-sources` or
// `--restricted` say, so a non-empty `env` there is refused, as is any key §4.3 refuses. It holds
// the client's own state (many keys), so it is not held to the settings allowlist.
//
// The managed settings, which outrank the engine's `--settings` file and which no flag excludes:
// `managed-settings.json` and every `.json` file in `managed-settings.d/` under
// /Library/Application Support/ClaudeCode (macOS) or /etc/claude-code (Linux); on macOS also the
// managed-preferences plists `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`
// and `/Library/Managed Preferences/com.anthropic.claudecode.plist`, converted to JSON with
// `/usr/bin/plutil -convert json` as the client converts them. On Windows the client reads the
// policy keys HKLM and HKCU\SOFTWARE\Policies\ClaudeCode, and under WSL also the Windows side's; the
// engine cannot read those, so it refuses to run there.
//
// A file that exists but cannot be read, converted or parsed is refused too, so the check fails
// closed. Only file paths and key names are reported, never values.

import { lstatSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { checkSettings } from "../env-refusals.ts";
import type { EnvRefusals } from "../env-refusals.ts";
import { escapeText } from "../display.ts";
import { runProgram } from "../exec.ts";
import { isJsonObject, parseJsonBytes, readJsonFile } from "../json.ts";
import type { Transport } from "../transport.ts";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;
/** The global configuration holds the client's state (projects, caches), so it may be larger. */
const MAX_GLOBAL_CONFIG_BYTES = 64 * 1024 * 1024;
/** What the client itself allows plutil: 5 seconds and 2 MiB of output. */
const PLUTIL = "/usr/bin/plutil";
const PLUTIL_TIMEOUT_MS = 5_000;
const PLUTIL_MAX_BYTES = 2 * 1024 * 1024;
const PLIST_NAME = "com.anthropic.claudecode.plist";
/** Present on WSL: the client then also reads the Windows side's managed settings and policy keys. */
export const WSL_REG_EXE = "/mnt/c/Windows/System32/reg.exe";

/** The managed-settings folder the pinned Claude Code reads on `platform`. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export const MANAGED_PREFERENCES_DIR = "/Library/Managed Preferences";

export interface SettingsRefusal {
  readonly file: string;
  readonly problem: string;
}

export type PlistConversion = { ok: true; json: Buffer } | { ok: false; error: string };

/** Everything that decides which files are checked; tests replace any of it. */
export interface SettingsSources {
  /** The session's Claude Code configuration directory. */
  readonly configDir: string;
  /** The folder of the global configuration, `.claude.json`. */
  readonly globalConfigDir: string;
  readonly managedDir: string;
  /** macOS only: the managed-preferences folder; null elsewhere. */
  readonly managedPreferencesDir: string | null;
  /** The user the client runs as, for the per-user plist; null when it cannot be read. */
  readonly user: string | null;
  readonly platform: NodeJS.Platform;
  /** Linux only: the file whose presence means WSL; null elsewhere. */
  readonly wslMarker: string | null;
  /** Entries the user settings' `env` block may hold, by name and exact value (the pool's own). */
  readonly allowedUserEnv: Readonly<Record<string, string>>;
  readonly convertPlist: (file: string) => Promise<PlistConversion>;
}

export interface SourceOverrides {
  readonly managedSettingsDir?: string;
  readonly managedPreferencesDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly wslMarker?: string;
  readonly convertPlist?: (file: string) => Promise<PlistConversion>;
}

/** Converts a plist to JSON the way the pinned client does: absolute plutil, a fixed environment. */
export async function convertPlistWithPlutil(file: string): Promise<PlistConversion> {
  try {
    const result = await runProgram(PLUTIL, ["-convert", "json", "-o", "-", "--", file], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C" },
      timeoutMs: PLUTIL_TIMEOUT_MS,
      maxOutputBytes: PLUTIL_MAX_BYTES,
    });
    if (result.code !== 0) return { ok: false, error: `plutil could not convert it (exit ${result.code ?? "signal"})` };
    return { ok: true, json: result.stdout };
  } catch (error) {
    return { ok: false, error: `plutil could not convert it (${escapeText(error instanceof Error ? error.message : String(error), 200)})` };
  }
}

function currentUser(): string | null {
  try {
    const name = userInfo().username;
    return name === "" || name.includes("/") || name.includes("\0") ? null : name;
  } catch {
    return null;
  }
}

/** The sources a session of `transport` reads, for a user whose HOME is `home`. */
export function settingsSources(home: string, transport: Transport, overrides: SourceOverrides = {}): SettingsSources {
  const platform = overrides.platform ?? process.platform;
  const pool = transport.kind === "pool";
  return {
    configDir: pool ? transport.configDir : join(home, ".claude"),
    globalConfigDir: pool ? transport.configDir : home,
    managedDir: overrides.managedSettingsDir ?? managedSettingsDir(platform),
    managedPreferencesDir: platform === "darwin" ? (overrides.managedPreferencesDir ?? MANAGED_PREFERENCES_DIR) : null,
    user: currentUser(),
    platform,
    wslMarker: platform === "linux" ? (overrides.wslMarker ?? WSL_REG_EXE) : null,
    allowedUserEnv: pool ? { ANTHROPIC_BASE_URL: transport.baseUrl, ANTHROPIC_AUTH_TOKEN: transport.authToken } : {},
    convertPlist: overrides.convertPlist ?? convertPlistWithPlutil,
  };
}

/** Whether `path` exists (as anything, a link included); throws for an error other than absence. */
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function errorCode(error: unknown): string {
  return String((error as NodeJS.ErrnoException).code ?? "error");
}

/** The user settings with the env entries the transport itself passes, at the same values, left out. */
function withoutAllowedEnv(settings: Record<string, unknown>, allowed: Readonly<Record<string, string>>): Record<string, unknown> {
  const env = settings["env"];
  if (!isJsonObject(env) || Object.keys(allowed).length === 0) return settings;
  const rest: Record<string, unknown> = {};
  for (const name of Object.keys(env)) if (!(Object.hasOwn(allowed, name) && env[name] === allowed[name])) rest[name] = env[name];
  const out: Record<string, unknown> = { ...settings };
  if (Object.keys(rest).length === 0) delete out["env"];
  else out["env"] = rest;
  return out;
}

/** The refused parts of a global configuration: a non-empty env, and any key §4.3 refuses. */
export function checkGlobalConfig(config: Record<string, unknown>, refusals: EnvRefusals): string[] {
  const out: string[] = [];
  for (const key of Object.keys(config)) {
    if (key === "env") {
      const env = config[key];
      if (!isJsonObject(env)) out.push("env");
      else for (const name of Object.keys(env)) out.push(`env.${escapeText(name, 80)}`);
    } else if (refusals.settingsKeys.includes(key)) out.push(escapeText(key, 80));
  }
  return out;
}

/** The files and folders checked, as D3 names them. */
export function checkedSources(sources: SettingsSources): string[] {
  const out = [
    join(sources.configDir, "settings.json"),
    join(sources.globalConfigDir, ".claude.json"),
    join(sources.configDir, ".config.json"),
    join(sources.configDir, "remote-settings.json"),
    join(sources.managedDir, "managed-settings.json"),
    join(sources.managedDir, "managed-settings.d"),
  ];
  if (sources.managedPreferencesDir !== null) {
    if (sources.user !== null) out.push(join(sources.managedPreferencesDir, sources.user, PLIST_NAME));
    out.push(join(sources.managedPreferencesDir, PLIST_NAME));
  }
  return out;
}

/**
 * Every source a session could read that sets something refused, cannot be read, converted or
 * parsed, or cannot be checked at all; empty when none does.
 */
export async function settingsRefusals(sources: SettingsSources, refusals: EnvRefusals): Promise<SettingsRefusal[]> {
  const out: SettingsRefusal[] = [];
  if (sources.platform === "win32") {
    out.push({ file: "HKLM and HKCU\\SOFTWARE\\Policies\\ClaudeCode", problem: "the managed policy keys the client reads on Windows cannot be checked; run fin-review on macOS or Linux" });
  }
  if (sources.wslMarker !== null) {
    try {
      if (exists(sources.wslMarker)) out.push({ file: sources.wslMarker, problem: "under WSL the client also reads the Windows side's managed settings and policy keys, which cannot be checked" });
    } catch (error) {
      out.push({ file: sources.wslMarker, problem: `cannot be checked (${errorCode(error)})` });
    }
  }

  const strict = (file: string, value: unknown, allowedEnv: Readonly<Record<string, string>> = {}): void => {
    if (!isJsonObject(value)) {
      out.push({ file, problem: "is not a JSON object" });
      return;
    }
    const keys = checkSettings(withoutAllowedEnv(value, allowedEnv), refusals);
    if (keys.length > 0) out.push({ file, problem: `sets refused keys: ${keys.join(", ")}` });
  };
  const readFile = (file: string, maxBytes: number): { value: unknown } | null => {
    const read = readJsonFile(file, maxBytes);
    if (read.ok) return { value: read.value };
    if (!read.missing) out.push({ file, problem: read.error });
    return null;
  };

  // The user settings of the session's configuration directory.
  const user = join(sources.configDir, "settings.json");
  const userRead = readFile(user, MAX_SETTINGS_BYTES);
  if (userRead !== null) strict(user, userRead.value, sources.allowedUserEnv);

  // The global configuration and its legacy file.
  for (const file of [join(sources.globalConfigDir, ".claude.json"), join(sources.configDir, ".config.json")]) {
    const read = readFile(file, MAX_GLOBAL_CONFIG_BYTES);
    if (read === null) continue;
    if (!isJsonObject(read.value)) {
      out.push({ file, problem: "is not a JSON object" });
      continue;
    }
    const keys = checkGlobalConfig(read.value, refusals);
    if (keys.length > 0) out.push({ file, problem: `sets refused keys: ${keys.join(", ")}` });
  }

  // Server-managed settings the client has cached.
  const remote = join(sources.configDir, "remote-settings.json");
  try {
    if (exists(remote)) out.push({ file: remote, problem: "holds cached server-managed settings, which cannot be checked" });
  } catch (error) {
    out.push({ file: remote, problem: `cannot be checked (${errorCode(error)})` });
  }

  // The managed settings files.
  const managed = [join(sources.managedDir, "managed-settings.json")];
  const dropIns = join(sources.managedDir, "managed-settings.d");
  try {
    for (const name of readdirSync(dropIns).sort()) if (name.endsWith(".json")) managed.push(join(dropIns, name));
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOENT" && code !== "ENOTDIR") out.push({ file: dropIns, problem: `cannot be listed (${code})` });
  }
  for (const file of managed) {
    const read = readFile(file, MAX_SETTINGS_BYTES);
    if (read !== null) strict(file, read.value);
  }

  // macOS managed preferences, converted as the client converts them.
  if (sources.managedPreferencesDir !== null) {
    const plists = [...(sources.user === null ? [] : [join(sources.managedPreferencesDir, sources.user, PLIST_NAME)]), join(sources.managedPreferencesDir, PLIST_NAME)];
    for (const file of plists) {
      let present: boolean;
      try {
        present = exists(file);
      } catch (error) {
        out.push({ file, problem: `cannot be checked (${errorCode(error)})` });
        continue;
      }
      if (!present) continue;
      const converted = await sources.convertPlist(file);
      if (!converted.ok) {
        out.push({ file, problem: converted.error });
        continue;
      }
      const parsed = parseJsonBytes(converted.json);
      if (!parsed.ok) out.push({ file, problem: `plutil's output is ${parsed.error}` });
      else strict(file, parsed.value);
    }
  }
  return out;
}
