// The settings file written fresh for each session (spec 07 §4.2), and its empty MCP config.
//
// The deny list never covers the reviewed tree. When the tree lies under the home directory (here
// always, in the trimmed Phase 0: sessions keep the real HOME, see docs/review/README.md), `~/**`
// and `<home>/**` are replaced by explicit denies of every entry beside the path that leads from
// the home to the tree, level by level, so the tree stays readable and nothing else under the home
// is. The same is done from $FIN_REVIEW_HOME down to the tree, so other runs' trees, the run
// directories, the state, the scratch homes and the repository mirrors are denied too.

import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const ALLOWED_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];
export const DENIED_TOOLS: readonly string[] = [
  "Bash",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "mcp__*",
];
const SYSTEM_DENIES: readonly string[] = ["Read(//proc/**)", "Read(//sys/**)", "Read(//dev/**)"];
/** $FIN_REVIEW_HOME's directories that are always denied by name (§4.2), and the mirrors. */
export const HOME_DENIED_DIRS: readonly string[] = ["runs", "state", "scratch", "ledger", "repos"];

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface SettingsInput {
  readonly modelId: string;
  /** Fast mode as it will run: true only for an Opus session with --fast. */
  readonly fastMode: boolean;
  /** The real home directory, absolute and resolved. */
  readonly home: string;
  /** $FIN_REVIEW_HOME, absolute and resolved. */
  readonly finReviewHome: string;
  /** The reviewed tree, absolute and resolved, inside $FIN_REVIEW_HOME. */
  readonly treeDir: string;
  /** Other absolute directories to deny ($FIN_REVIEW_SPOOL, $FIN_REVIEW_SHARE when set). */
  readonly extraDenied: readonly string[];
  /** Lists a directory; absent or unreadable gives []. */
  readonly listDir?: (dir: string) => DirEntry[];
}

export interface SessionSettings {
  model: string;
  availableModels: string[];
  availableModelsMatch: "exact";
  switchModelsOnFlag: false;
  fastMode: boolean;
  permissions: { defaultMode: "dontAsk"; allow: string[]; deny: string[] };
  env: Record<string, never>;
}

export const MCP_CONFIG = Object.freeze({ mcpServers: Object.freeze({}) });

const SAFE_NAME_RE = /^[A-Za-z0-9._@+ ,=-]+$/;

function defaultListDir(dir: string): DirEntry[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  } catch {
    return [];
  }
}

/** True when `child` is `parent` or lies below it. */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function assertAbsolute(path: string, what: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.includes("\n") || path.split("/").includes("..")) {
    throw new TypeError(`${what} must be an absolute path with no .. segment`);
  }
}

/** A permission-rule path segment: characters outside a safe set become `?`. */
function ruleName(name: string): string {
  if (SAFE_NAME_RE.test(name)) return name;
  let out = "";
  for (const ch of name) out += /[A-Za-z0-9._@+ ,=-]/.test(ch) ? ch : "?";
  return out;
}

function wildcardMatches(pattern: string, name: string): boolean {
  const a = [...pattern];
  const b = [...name];
  return a.length === b.length && a.every((ch, i) => ch === "?" || ch === b[i]);
}

function readRule(absolute: string, directory: boolean): string {
  return directory ? `Read(/${absolute}/**)` : `Read(/${absolute})`;
}

/**
 * Denies every entry beside the path from `top` down to `target` (exclusive of the path itself).
 * Throws when an entry's name cannot be written as a rule without also matching the kept path.
 */
function siblingDenies(top: string, target: string, listDir: (dir: string) => DirEntry[]): string[] {
  const out: string[] = [];
  const segments = relative(top, target).split(sep).filter((segment) => segment !== "");
  let dir = top;
  for (const keep of segments) {
    for (const entry of listDir(dir).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
      if (entry.name === keep) continue;
      const name = ruleName(entry.name);
      if (name !== entry.name && wildcardMatches(name, keep)) {
        throw new TypeError(`cannot deny ${JSON.stringify(join(dir, entry.name))} without denying the reviewed tree`);
      }
      out.push(readRule(`${dir === "/" ? "" : dir}/${name}`, entry.isDirectory));
    }
    dir = join(dir, keep);
  }
  return out;
}

/** The settings of spec 07 §4.2 for one session. */
export function buildSettings(input: SettingsInput): SessionSettings {
  assertAbsolute(input.home, "home");
  assertAbsolute(input.finReviewHome, "FIN_REVIEW_HOME");
  assertAbsolute(input.treeDir, "the tree");
  for (const dir of input.extraDenied) assertAbsolute(dir, "a denied directory");
  if (!isWithin(input.finReviewHome, input.treeDir) || input.treeDir === input.finReviewHome) {
    throw new TypeError("the reviewed tree must lie inside FIN_REVIEW_HOME");
  }
  const listDir = input.listDir ?? defaultListDir;
  const deny: string[] = [...DENIED_TOOLS, ...SYSTEM_DENIES];
  if (isWithin(input.home, input.treeDir)) {
    // §4.2: `Read(~/**)` and `Read(<real home>/**)` would cover the tree; deny around it instead.
    deny.push(...siblingDenies(input.home, input.finReviewHome, listDir));
  } else {
    deny.push("Read(~/**)", readRule(input.home, true));
  }
  for (const name of HOME_DENIED_DIRS) deny.push(readRule(join(input.finReviewHome, name), true));
  for (const rule of siblingDenies(input.finReviewHome, input.treeDir, listDir)) if (!deny.includes(rule)) deny.push(rule);
  for (const dir of input.extraDenied) {
    if (isWithin(dir, input.treeDir)) throw new TypeError("a denied directory holds the reviewed tree");
    deny.push(readRule(dir, true));
  }
  return {
    model: input.modelId,
    availableModels: [input.modelId],
    availableModelsMatch: "exact",
    switchModelsOnFlag: false,
    fastMode: input.fastMode,
    permissions: { defaultMode: "dontAsk", allow: [...ALLOWED_TOOLS], deny },
    env: {},
  };
}

/** Writes settings.json and mcp.json into `sessionDir` (created 0700) and returns their paths. */
export function writeSessionFiles(sessionDir: string, settings: SessionSettings): { settingsPath: string; mcpPath: string } {
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(sessionDir, "settings.json");
  const mcpPath = join(sessionDir, "mcp.json");
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mcpPath, `${JSON.stringify(MCP_CONFIG)}\n`, { mode: 0o600 });
  return { settingsPath, mcpPath };
}
