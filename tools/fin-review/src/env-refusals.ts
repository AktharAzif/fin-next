// The variables and settings the engine refuses to see (spec 07 §4.3, [RV-19]), from
// config/env-refusals.json. A command that starts a session checks its own environment with
// checkEnvironment and every settings file Claude Code could read with checkSettings, and exits
// 78 (`environment_refused`) before any session when either finds something.
//
// §4.3's table is a floor: any name the pinned Claude Code reads that changes the model, the
// effort, the endpoint, the credential or the settings source is refused too. A hand-made list of
// such names cannot keep up with the client, so its own families are refused by default: every
// CLAUDE* and ANTHROPIC_* name, and every name holding OAUTH, is refused unless `allowed` lists it
// (the CI federation inputs and the session settings of §4.3, and the local credential of §7.3)
// or `sessionMarkers` does. The engine runs from the agents' Claude Code sessions (EXECUTION EX-09,
// §7.1), and Claude Code sets a few names in every command its tools run that only say which
// session is calling (CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, CLAUDE_CODE_SESSION_ID, the session's
// messaging socket and the like). Those are tolerated: none changes what a review session runs, and
// none reaches one, since each session's environment is built from nothing (§4.3). A marker must
// be a name only the client's generic families (kind `client`) would refuse, so no name that a
// listed entry or a model, effort, endpoint, credential or settings family covers is tolerated
// this way, except as an entry that names the one other family the name is in and says why
// (CLAUDE_EFFORT: the calling session's effort, which the client writes into every tool command
// and never reads; §4.3 refuses CLAUDE_CODE_EFFORT_LEVEL, the name it reads).
// Exact names give the kind of the known ones (CLAUDE_CODE_EXTRA_BODY, which rewrites the request
// body, is a model refusal); the other patterns refuse the families outside those prefixes (every
// provider switch, *_BASE_URL, *_PROXY, *_API_KEY, *_AUTH_TOKEN, *_MODEL, effort, thinking,
// fallback, extra-body and output-token name, and the runtime's own NODE_*, BUN_* and SSL_CERT_*
// settings). A pattern's kind is the first that matches, so the generic CLAUDE* family, kind
// `client` (a client variable not known to be harmless), comes last.
//
// Settings: a session's environment is built from nothing (§4.3), so a settings file's `env` block
// is refused whatever it names. Top-level keys are refused unless listed as harmless
// (`settingsAllowedKeys`, display and retention settings); `settingsKeys` is §4.3's list, refused
// in any case. `permissions` may only narrow what §4.2 grants: allow nothing but Read, Grep and
// Glob, and use no mode that skips the permission check.

import { escapeText } from "./display.ts";
import { isJsonObject, ownKeys } from "./json.ts";

export type RefusalKind = "endpoint" | "model" | "credential" | "injection" | "settings" | "client";
const KINDS: readonly RefusalKind[] = [
  "endpoint",
  "model",
  "credential",
  "injection",
  "settings",
  "client",
];

export interface RefusedVariable {
  readonly name: string;
  readonly kind: RefusalKind;
  /** The one value that is accepted, when the variable has one (ANTHROPIC_BASE_URL). */
  readonly allowedValue?: string;
}

/** A family of refused names: those starting with, or containing, `text` (upper case). */
export interface RefusedPattern {
  readonly match: "prefix" | "contains";
  readonly text: string;
  readonly kind: RefusalKind;
}

export interface EnvRefusals {
  readonly variables: readonly RefusedVariable[];
  readonly patterns: readonly RefusedPattern[];
  /** Names a pattern would refuse that the engine needs; an exact entry in `variables` still wins. */
  readonly allowed: readonly string[];
  /**
   * Names Claude Code sets in its tools' commands that only identify the calling session; each is
   * one that only `client` patterns match (or an exception the file names with its one other
   * family and a reason), and is tolerated in the engine's own environment.
   */
  readonly sessionMarkers: readonly string[];
  /** §4.3's settings keys, refused wherever they appear. */
  readonly settingsKeys: readonly string[];
  /** The top-level settings keys that change nothing a review depends on; every other key is refused. */
  readonly settingsAllowedKeys: readonly string[];
}

export interface EnvironmentRefusal {
  name: string;
  kind: RefusalKind;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const PATTERN_TEXT_RE = /^[A-Z0-9_]+$/;
const SETTINGS_KEY_RE = /^\$?[A-Za-z][A-Za-z0-9]*$/;
const TOP_KEYS = new Set([
  "version",
  "note",
  "variables",
  "patterns",
  "allowed",
  "sessionMarkers",
  "settingsKeys",
  "settingsAllowedKeys",
]);
/** The lists of variable names nameList reads; the other lists it reads hold settings keys. */
const NAME_LISTS: ReadonlySet<string> = new Set(["allowed"]);

/** §4.2's grant: the only tools a session may be allowed. */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob"]);
/** Permission modes that keep the permission check: anything not allowed is asked (and so refused in -p) or denied. */
const ALLOWED_MODES: ReadonlySet<string> = new Set(["default", "dontAsk", "plan"]);
/** permissions keys that can only narrow what a session may do. */
const NARROWING_PERMISSION_KEYS: ReadonlySet<string> = new Set([
  "deny",
  "ask",
  "disableBypassPermissionsMode",
  "denyInsteadOfPrompting",
]);

function isKind(value: unknown): value is RefusalKind {
  return typeof value === "string" && (KINDS as readonly string[]).includes(value);
}

function nameList(raw: unknown, field: string, errors: string[], allowEmpty: boolean): string[] {
  const out: string[] = [];
  if (!Array.isArray(raw) || (!allowEmpty && raw.length === 0)) {
    errors.push(`${field} must be ${allowEmpty ? "an" : "a non-empty"} array`);
    return out;
  }
  for (const item of raw) {
    const valid =
      typeof item === "string" && (NAME_LISTS.has(field) ? NAME_RE : SETTINGS_KEY_RE).test(item);
    if (!valid) errors.push(`${field} holds ${JSON.stringify(item)}`);
    else if (out.includes(item as string)) errors.push(`${field} lists ${item as string} twice`);
    else out.push(item as string);
  }
  return out;
}

/** One sessionMarkers entry: the name, and the one refused family it is in when it is an exception. */
interface SessionMarker {
  readonly name: string;
  readonly family: RefusalKind | null;
}

/**
 * sessionMarkers: each entry a name (in the client families only), or an exception to that rule:
 * `{ "name", "family", "why" }`, which names the one other family the name is in and says why the
 * client's value of it cannot change a review.
 */
function sessionMarkerList(raw: unknown, errors: string[]): SessionMarker[] {
  const out: SessionMarker[] = [];
  if (!Array.isArray(raw)) {
    errors.push("sessionMarkers must be an array");
    return out;
  }
  raw.forEach((item, index) => {
    const marker = sessionMarker(item, `sessionMarkers[${index}]`, errors);
    if (marker === null) return;
    if (out.some((other) => other.name === marker.name))
      errors.push(`sessionMarkers lists ${marker.name} twice`);
    else out.push(marker);
  });
  return out;
}

function sessionMarker(item: unknown, at: string, errors: string[]): SessionMarker | null {
  if (typeof item === "string") {
    if (NAME_RE.test(item)) return { name: item, family: null };
    errors.push(`sessionMarkers holds ${JSON.stringify(item)}`);
    return null;
  }
  if (!isJsonObject(item)) {
    errors.push(`${at} must be a variable name or an object`);
    return null;
  }
  const name = item["name"];
  const family = item["family"];
  const why = item["why"];
  if (ownKeys(item).some((key) => key !== "name" && key !== "family" && key !== "why"))
    errors.push(`${at} has an unknown key`);
  else if (typeof name !== "string" || !NAME_RE.test(name))
    errors.push(`${at}.name must be an upper-case variable name`);
  else if (!isKind(family) || family === "client")
    errors.push(`${at}.family must be a refused family other than client`);
  else if (typeof why !== "string" || why.trim() === "")
    errors.push(`${at}.why must say why the client's value cannot change a review`);
  else return { name, family };
  return null;
}

/** Validates config/env-refusals.json. */
export function parseEnvRefusals(
  value: unknown,
): { ok: true; value: EnvRefusals } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of ownKeys(value)) {
    if (typeof key !== "string" || !TOP_KEYS.has(key))
      errors.push(`unknown key ${JSON.stringify(String(key))}`);
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  if (Object.hasOwn(value, "note") && typeof value["note"] !== "string")
    errors.push("note must be a string");
  const variables: RefusedVariable[] = [];
  const seen = new Set<string>();
  const rawVariables = value["variables"];
  if (!Array.isArray(rawVariables) || rawVariables.length === 0)
    errors.push("variables must be a non-empty array");
  else {
    rawVariables.forEach((entry, index) => {
      if (!isJsonObject(entry)) {
        errors.push(`variables[${index}] must be an object`);
        return;
      }
      for (const key of ownKeys(entry)) {
        if (key !== "name" && key !== "kind" && key !== "allowedValue") {
          errors.push(`variables[${index}] has unknown key ${JSON.stringify(String(key))}`);
        }
      }
      const name = entry["name"];
      const kind = entry["kind"];
      const allowedValue = entry["allowedValue"];
      if (typeof name !== "string" || !NAME_RE.test(name)) {
        errors.push(`variables[${index}].name must be an upper-case variable name`);
        return;
      }
      if (seen.has(name)) errors.push(`variables lists ${name} twice`);
      seen.add(name);
      if (!isKind(kind)) {
        errors.push(`variables[${index}].kind must be one of ${KINDS.join(", ")}`);
        return;
      }
      if (allowedValue !== undefined && (typeof allowedValue !== "string" || allowedValue === "")) {
        errors.push(`variables[${index}].allowedValue must be a non-empty string`);
        return;
      }
      variables.push(
        Object.freeze(allowedValue === undefined ? { name, kind } : { name, kind, allowedValue }),
      );
    });
  }
  const patterns: RefusedPattern[] = [];
  const rawPatterns = value["patterns"];
  if (!Array.isArray(rawPatterns) || rawPatterns.length === 0)
    errors.push("patterns must be a non-empty array");
  else {
    rawPatterns.forEach((entry, index) => {
      if (!isJsonObject(entry)) {
        errors.push(`patterns[${index}] must be an object`);
        return;
      }
      for (const key of ownKeys(entry)) {
        if (key !== "prefix" && key !== "contains" && key !== "kind")
          errors.push(`patterns[${index}] has unknown key ${JSON.stringify(String(key))}`);
      }
      const hasPrefix = Object.hasOwn(entry, "prefix");
      if (hasPrefix === Object.hasOwn(entry, "contains")) {
        errors.push(`patterns[${index}] must have exactly one of prefix and contains`);
        return;
      }
      const text = hasPrefix ? entry["prefix"] : entry["contains"];
      const kind = entry["kind"];
      if (typeof text !== "string" || !PATTERN_TEXT_RE.test(text)) {
        errors.push(`patterns[${index}] text must be upper-case letters, digits and _`);
        return;
      }
      if (!isKind(kind)) {
        errors.push(`patterns[${index}].kind must be one of ${KINDS.join(", ")}`);
        return;
      }
      if (
        patterns.some(
          (other) => other.text === text && other.match === (hasPrefix ? "prefix" : "contains"),
        )
      ) {
        errors.push(`patterns lists ${text} twice`);
      }
      patterns.push(Object.freeze({ match: hasPrefix ? "prefix" : "contains", text, kind }));
    });
  }
  const allowed = nameList(value["allowed"], "allowed", errors, true);
  for (const name of allowed)
    if (seen.has(name)) errors.push(`${name} is both refused and allowed`);
  const markers = sessionMarkerList(value["sessionMarkers"], errors);
  const sessionMarkers = markers.map((marker) => marker.name);
  for (const { name, family: named } of markers) {
    const kinds = patterns
      .filter((pattern) => matchesPattern(name, pattern))
      .map((pattern) => pattern.kind);
    const families = [...new Set(kinds.filter((kind) => kind !== "client"))];
    if (seen.has(name)) errors.push(`${name} is both refused and a session marker`);
    else if (allowed.includes(name)) errors.push(`${name} is both allowed and a session marker`);
    else if (kinds.length === 0)
      errors.push(`session marker ${name} is refused by no pattern, so it needs no entry`);
    else if (named === null && families.length > 0)
      errors.push(
        `session marker ${name} is in the ${families.join(", ")} families, so it cannot be tolerated`,
      );
    else if (named !== null && (families.length !== 1 || families[0] !== named))
      errors.push(
        `session marker ${name} names the ${named} family, but is in ${families.length === 0 ? "none" : `the ${families.join(", ")} families`}`,
      );
  }
  const settingsKeys = nameList(value["settingsKeys"], "settingsKeys", errors, false);
  const settingsAllowedKeys = nameList(
    value["settingsAllowedKeys"],
    "settingsAllowedKeys",
    errors,
    false,
  );
  for (const key of settingsKeys)
    if (settingsAllowedKeys.includes(key))
      errors.push(`settings key ${key} is both refused and allowed`);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze({
      variables: Object.freeze(variables),
      patterns: Object.freeze(patterns),
      allowed: Object.freeze(allowed),
      sessionMarkers: Object.freeze(sessionMarkers),
      settingsKeys: Object.freeze(settingsKeys),
      settingsAllowedKeys: Object.freeze(settingsAllowedKeys),
    }),
  };
}

function matchesPattern(upper: string, pattern: RefusedPattern): boolean {
  return pattern.match === "prefix" ? upper.startsWith(pattern.text) : upper.includes(pattern.text);
}

/**
 * The refused variables present in `env`. Names compare without regard to case (Windows reads
 * the environment that way, and proxies are honoured in lower case too); a variable set to the
 * empty string counts as present. A listed name wins over the patterns, so its allowed value (if
 * any) is the only way through; an `allowed` name and a session marker pass the patterns.
 */
export function checkEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  refusals: EnvRefusals,
): EnvironmentRefusal[] {
  const byUpper = new Map<string, RefusedVariable>();
  for (const variable of refusals.variables) byUpper.set(variable.name.toUpperCase(), variable);
  const allowed = new Set(
    [...refusals.allowed, ...refusals.sessionMarkers].map((name) => name.toUpperCase()),
  );
  const out: EnvironmentRefusal[] = [];
  for (const name of Object.keys(env).sort()) {
    const value = env[name];
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    const variable = byUpper.get(upper);
    if (variable !== undefined) {
      if (variable.allowedValue !== undefined && value === variable.allowedValue) continue;
      out.push({ name, kind: variable.kind });
      continue;
    }
    if (allowed.has(upper)) continue;
    const pattern = refusals.patterns.find((candidate) => matchesPattern(upper, candidate));
    if (pattern !== undefined) out.push({ name, kind: pattern.kind });
  }
  return out;
}

/** The refused parts of a `permissions` value, as `permissions...` paths. */
function permissionRefusals(permissions: unknown): string[] {
  if (!isJsonObject(permissions)) return ["permissions"];
  const out: string[] = [];
  for (const key of Object.keys(permissions)) {
    const value = permissions[key];
    if (key === "allow") {
      if (!Array.isArray(value)) out.push("permissions.allow");
      else
        value.forEach((rule, index) => {
          if (typeof rule !== "string" || !ALLOWED_TOOLS.has(rule))
            out.push(`permissions.allow[${index}]`);
        });
    } else if (key === "defaultMode") {
      if (typeof value !== "string" || !ALLOWED_MODES.has(value))
        out.push("permissions.defaultMode");
    } else if (!NARROWING_PERMISSION_KEYS.has(key)) out.push(`permissions.${escapeText(key, 80)}`);
  }
  return out;
}

/**
 * The refused parts of one settings object: every top-level key that is not listed as harmless
 * (and every key of §4.3's list), every entry of an `env` block, and every `permissions` entry
 * that would widen §4.2's grant. Keys are returned escaped.
 */
export function checkSettings(settings: unknown, refusals: EnvRefusals): string[] {
  if (!isJsonObject(settings)) return [];
  const out: string[] = [];
  for (const key of Object.keys(settings)) {
    const value = settings[key];
    if (key === "env") {
      if (!isJsonObject(value)) out.push("env");
      else for (const name of Object.keys(value)) out.push(`env.${escapeText(name, 80)}`);
    } else if (key === "permissions") {
      out.push(...permissionRefusals(value));
    } else if (refusals.settingsKeys.includes(key) || !refusals.settingsAllowedKeys.includes(key)) {
      out.push(escapeText(key, 80));
    }
  }
  return out;
}
