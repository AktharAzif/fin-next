// The pinned Claude Code (spec 07 §4.1, S7-28): config/client.json, version comparison, and the one
// file a run uses. claudePath is usually a link that an updater re-points while other sessions run,
// so a run resolves it once to the file it names, checks that file's version, starts every session
// from that file, and refuses an attempt when the file is no longer the one it checked.

import { realpathSync, statSync } from "node:fs";
import { ConfigError } from "../errors.ts";
import { isJsonObject } from "../json.ts";

const RESOLVED_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;

/** The file a run starts every session from, and what it was when its version was checked. */
export interface PinnedClient {
  readonly path: string;
  readonly fingerprint: string;
}

/** Device, inode, size and times of `path`: any update replaces or rewrites it. Null when it cannot be read. */
export function clientFingerprint(path: string): string | null {
  try {
    const stats = statSync(path, { bigint: true });
    if (!stats.isFile()) return null;
    return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");
  } catch {
    return null;
  }
}

/** Resolves `claudePath` (links followed) to the file it names now. Throws ConfigError. */
export function pinClient(claudePath: string): PinnedClient {
  let path: string;
  try {
    path = realpathSync.native(claudePath);
  } catch {
    throw new ConfigError("$FIN_REVIEW_HOME/config.json", ["claudePath does not name a file that exists"]);
  }
  if (!RESOLVED_PATH_RE.test(path) || path.split("/").includes("..")) {
    throw new ConfigError("$FIN_REVIEW_HOME/config.json", ["claudePath resolves to a path of characters the engine refuses"]);
  }
  const fingerprint = clientFingerprint(path);
  if (fingerprint === null) throw new ConfigError("$FIN_REVIEW_HOME/config.json", ["claudePath does not name a regular file"]);
  return { path, fingerprint };
}

export interface ClientConfig {
  /** The exact version every session must run. */
  readonly claudeCode: string;
  /** The oldest version the engine supports; the pin is at least this. */
  readonly minimum: string;
}

const VERSION_RE = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,5})$/;

export function isVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_RE.test(value);
}

/** Compares two x.y.z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The version in `claude --version` output ("2.1.328 (Claude Code)"), or null. */
export function parseVersionOutput(text: string): string | null {
  const match = /^([0-9]+\.[0-9]+\.[0-9]+) \(Claude Code\)\s*$/.exec(text.trim());
  const version = match?.[1];
  return version !== undefined && isVersion(version) ? version : null;
}

/** Validates config/client.json. */
export function parseClientConfig(value: unknown): { ok: true; value: ClientConfig } | { ok: false; errors: string[] } {
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "claudeCode" && key !== "minimum" && key !== "note") errors.push(`unknown key ${JSON.stringify(key)}`);
  }
  if (Object.hasOwn(value, "note") && typeof value["note"] !== "string") errors.push("note must be a string");
  const pin = value["claudeCode"];
  const minimum = value["minimum"];
  if (!isVersion(pin)) errors.push("claudeCode must be a version x.y.z");
  if (!isVersion(minimum)) errors.push("minimum must be a version x.y.z");
  if (isVersion(pin) && isVersion(minimum) && compareVersions(pin, minimum) < 0) errors.push("claudeCode must be at least minimum");
  if (errors.length > 0 || !isVersion(pin) || !isVersion(minimum)) return { ok: false, errors };
  return { ok: true, value: Object.freeze({ claudeCode: pin, minimum }) };
}
