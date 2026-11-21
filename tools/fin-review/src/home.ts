// $FIN_REVIEW_HOME and the machine's own settings in $FIN_REVIEW_HOME/config.json (spec 07 §4.1,
// §4.9): the absolute path of the pinned Claude Code (`claudePath`) and the session concurrency
// (`maxSessions`). The file's `options` belong to the options validator (src/options.ts) and are
// not read here; any other key is refused so a typo is never silently ignored.

import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ConfigError } from "./errors.ts";
import { canonicalPath, isInsideOnDisk } from "./exec.ts";
import { isJsonObject, readJsonFile } from "./json.ts";
import { MAX_CONFIG_BYTES } from "./options.ts";

export interface MachineConfig {
  /** The pinned Claude Code, absolute; never found through PATH. */
  readonly claudePath: string;
  /** Sessions at once on this machine, sceptics included (spec 07 §4.9, §5.5). */
  readonly maxSessions: number;
}

export const DEFAULT_MAX_SESSIONS = 8;
const MAX_SESSIONS_LIMIT = 32;
const MACHINE_KEYS: ReadonlySet<string> = new Set(["options", "claudePath", "maxSessions", "maxRuns"]);
const PROGRAM_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

/** $FIN_REVIEW_HOME, or `${HOME}/.fin-review` when unset. Throws ConfigError when unusable. */
export function finReviewHome(env: Readonly<Record<string, string | undefined>>): string {
  const set = env["FIN_REVIEW_HOME"];
  if (set !== undefined && set !== "") {
    if (!isAbsolute(set) || set.includes("\0") || set.split("/").includes("..")) {
      throw new ConfigError("$FIN_REVIEW_HOME", ["must be an absolute path with no .. segment"]);
    }
    return set;
  }
  const home = env["HOME"];
  if (home === undefined || !isAbsolute(home) || home.includes("\0")) {
    throw new ConfigError("$FIN_REVIEW_HOME", ["is unset and HOME is not an absolute path"]);
  }
  return join(home, ".fin-review");
}

/** The deepest folder of `path` that exists (itself when it does), in the disk's own spelling. */
function deepestExisting(path: string): string {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return canonicalPath(current);
}

/**
 * True when `path`, which may not exist yet, would lie in or below the existing folder `root`,
 * decided on the disk as the program lookup decides it: by canonical paths (links resolved, the
 * disk's own spelling where it ignores case), then by device and inode up the folders. So neither
 * another spelling nor a link hides a home inside a repository.
 */
export function wouldLieInside(path: string, root: string): boolean {
  return isInsideOnDisk(deepestExisting(path), root);
}

/** Creates $FIN_REVIEW_HOME (0700) when missing and returns its resolved path, in the disk's own spelling. */
export function ensureHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  return realpathSync.native(home);
}

/**
 * Refuses (ConfigError) a $FIN_REVIEW_HOME in or below any of `roots` (the repository under review,
 * the engine's repository): its runs, mirrors and trees must never land in a working copy.
 */
export function guardHome(home: string, roots: readonly string[]): void {
  for (const root of roots) {
    if (wouldLieInside(home, root)) throw new ConfigError("$FIN_REVIEW_HOME", ["must not lie inside the repository under review or the engine's repository"]);
  }
}

/** Reads the machine settings; a missing file gives the defaults. */
export function loadMachineConfig(home: string, env: Readonly<Record<string, string | undefined>>): MachineConfig {
  const file = "$FIN_REVIEW_HOME/config.json";
  const userHome = env["HOME"];
  const defaultClaude = userHome !== undefined && isAbsolute(userHome) ? join(userHome, ".local", "bin", "claude") : "";
  const read = readJsonFile(join(home, "config.json"), MAX_CONFIG_BYTES);
  let value: Record<string, unknown> = {};
  if (!read.ok) {
    if (!read.missing) throw new ConfigError(file, [read.error]);
  } else if (!isJsonObject(read.value)) {
    throw new ConfigError(file, ["must be a JSON object"]);
  } else value = read.value;
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!MACHINE_KEYS.has(key)) errors.push(`unknown key ${JSON.stringify(key)}`);
  const claudePath = Object.hasOwn(value, "claudePath") ? value["claudePath"] : defaultClaude;
  if (typeof claudePath !== "string" || !PROGRAM_PATH_RE.test(claudePath) || claudePath.split("/").includes("..")) {
    errors.push("claudePath must be an absolute path of letters, digits, . _ / and - (HOME must be set for the default)");
  }
  const maxSessions = Object.hasOwn(value, "maxSessions") ? value["maxSessions"] : DEFAULT_MAX_SESSIONS;
  if (typeof maxSessions !== "number" || !Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > MAX_SESSIONS_LIMIT) {
    errors.push(`maxSessions must be an integer from 1 to ${MAX_SESSIONS_LIMIT}`);
  }
  if (Object.hasOwn(value, "maxRuns")) {
    const maxRuns = value["maxRuns"];
    if (typeof maxRuns !== "number" || !Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 16) errors.push("maxRuns must be an integer from 1 to 16");
  }
  if (errors.length > 0) throw new ConfigError(file, errors);
  return Object.freeze({ claudePath: claudePath as string, maxSessions: maxSessions as number });
}
