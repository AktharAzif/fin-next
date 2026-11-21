// The settings files a locked session's Claude Code could read (spec 07 §4.3), refused before any
// session when one sets a key config/env-refusals.json refuses (exit 78, `settings_refused`).
//
// Which files, for the pinned 2.1.328 (read from the client itself on 21 Nov 2026): the user
// settings, `<config dir>/settings.json`, where the config dir is $HOME/.claude for a session (it
// keeps the engine's HOME, and CLAUDE_CONFIG_DIR is refused); and the managed settings of the
// operating system, `managed-settings.json` and every `.json` file in `managed-settings.d/`, under
// /Library/Application Support/ClaudeCode on macOS, /etc/claude-code on Linux and
// C:\Program Files\ClaudeCode on Windows. Sessions pass `--setting-sources ""`, which keeps user and
// project settings out; this check is the second layer, and covers the managed settings that flag
// cannot exclude. A file that exists but cannot be read or parsed is refused too, so the check fails
// closed. Only file paths and key names are reported, never values.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { checkSettings } from "../env-refusals.ts";
import type { EnvRefusals } from "../env-refusals.ts";
import { isJsonObject, readJsonFile } from "../json.ts";

const MAX_SETTINGS_BYTES = 4 * 1024 * 1024;

/** The managed-settings folder the pinned Claude Code reads on `platform`. */
export function managedSettingsDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

export interface SettingsRefusal {
  readonly file: string;
  readonly problem: string;
}

/** The settings files to check, and folders that could not be listed. */
function candidates(home: string, managedDir: string): { files: string[]; refusals: SettingsRefusal[] } {
  const files = [join(home, ".claude", "settings.json"), join(managedDir, "managed-settings.json")];
  const refusals: SettingsRefusal[] = [];
  const dropIns = join(managedDir, "managed-settings.d");
  try {
    for (const name of readdirSync(dropIns).sort()) if (name.endsWith(".json")) files.push(join(dropIns, name));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") refusals.push({ file: dropIns, problem: `cannot be listed (${String(code ?? "error")})` });
  }
  return { files, refusals };
}

/**
 * Every settings file a session could read that sets a refused key, cannot be read, or is not
 * strict JSON; empty when none does. `home` is the session's HOME.
 */
export function settingsRefusals(home: string, managedDir: string, refusals: EnvRefusals): SettingsRefusal[] {
  const { files, refusals: out } = candidates(home, managedDir);
  for (const file of files) {
    const read = readJsonFile(file, MAX_SETTINGS_BYTES);
    if (!read.ok) {
      if (!read.missing) out.push({ file, problem: read.error });
      continue;
    }
    if (!isJsonObject(read.value)) {
      out.push({ file, problem: "is not a JSON object" });
      continue;
    }
    const keys = checkSettings(read.value, refusals);
    if (keys.length > 0) out.push({ file, problem: `sets refused keys: ${keys.join(", ")}` });
  }
  return out;
}
