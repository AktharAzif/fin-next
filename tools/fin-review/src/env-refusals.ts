// The variables and settings keys the engine refuses to see (spec 07 §4.3, [RV-19]), from
// config/env-refusals.json. A command that starts a session checks its own environment with
// checkEnvironment and every settings file Claude Code could read with checkSettings, and exits
// 78 (`environment_refused`) before any session when either finds something.

import { isJsonObject } from "./json.ts";

export type RefusalKind = "endpoint" | "model" | "credential" | "injection";
const KINDS: readonly RefusalKind[] = ["endpoint", "model", "credential", "injection"];

export interface RefusedVariable {
  readonly name: string;
  readonly kind: RefusalKind;
  /** The one value that is accepted, when the variable has one (ANTHROPIC_BASE_URL). */
  readonly allowedValue?: string;
}

export interface EnvRefusals {
  readonly variables: readonly RefusedVariable[];
  readonly settingsKeys: readonly string[];
}

export interface EnvironmentRefusal {
  name: string;
  kind: RefusalKind;
}

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SETTINGS_KEY_RE = /^[A-Za-z][A-Za-z0-9]*$/;

/** Validates config/env-refusals.json. */
export function parseEnvRefusals(value: unknown): { ok: true; value: EnvRefusals } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "version" && key !== "variables" && key !== "settingsKeys") {
      errors.push(`unknown key ${JSON.stringify(String(key))}`);
    }
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  const variables: RefusedVariable[] = [];
  const seen = new Set<string>();
  const rawVariables = value["variables"];
  if (!Array.isArray(rawVariables) || rawVariables.length === 0) errors.push("variables must be a non-empty array");
  else {
    rawVariables.forEach((entry, index) => {
      if (!isJsonObject(entry)) {
        errors.push(`variables[${index}] must be an object`);
        return;
      }
      for (const key of Reflect.ownKeys(entry)) {
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
      if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) {
        errors.push(`variables[${index}].kind must be one of ${KINDS.join(", ")}`);
        return;
      }
      if (allowedValue !== undefined && (typeof allowedValue !== "string" || allowedValue === "")) {
        errors.push(`variables[${index}].allowedValue must be a non-empty string`);
        return;
      }
      variables.push(
        Object.freeze(
          allowedValue === undefined
            ? { name, kind: kind as RefusalKind }
            : { name, kind: kind as RefusalKind, allowedValue },
        ),
      );
    });
  }
  const settingsKeys: string[] = [];
  const rawKeys = value["settingsKeys"];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) errors.push("settingsKeys must be a non-empty array");
  else {
    for (const key of rawKeys) {
      if (typeof key !== "string" || !SETTINGS_KEY_RE.test(key)) errors.push(`settingsKeys holds ${JSON.stringify(key)}`);
      else if (settingsKeys.includes(key)) errors.push(`settingsKeys lists ${key} twice`);
      else settingsKeys.push(key);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: Object.freeze({ variables: Object.freeze(variables), settingsKeys: Object.freeze(settingsKeys) }) };
}

/**
 * The refused variables present in `env`. Names compare without regard to case (Windows reads
 * the environment that way, and proxies are honoured in lower case too); a variable set to the
 * empty string counts as present.
 */
export function checkEnvironment(env: Readonly<Record<string, string | undefined>>, refusals: EnvRefusals): EnvironmentRefusal[] {
  const byUpper = new Map<string, RefusedVariable>();
  for (const variable of refusals.variables) byUpper.set(variable.name.toUpperCase(), variable);
  const out: EnvironmentRefusal[] = [];
  for (const name of Object.keys(env).sort()) {
    const variable = byUpper.get(name.toUpperCase());
    if (variable === undefined) continue;
    const value = env[name];
    if (value === undefined) continue;
    if (variable.allowedValue !== undefined && value === variable.allowedValue) continue;
    out.push({ name, kind: variable.kind });
  }
  return out;
}

/**
 * The refused keys in one settings object: a top-level key from `settingsKeys`, and an `env`
 * block that names a refused variable (whatever its value).
 */
export function checkSettings(settings: unknown, refusals: EnvRefusals): string[] {
  if (!isJsonObject(settings)) return [];
  const out: string[] = [];
  for (const key of Object.keys(settings)) {
    if (refusals.settingsKeys.includes(key)) out.push(key);
  }
  const env = settings["env"];
  if (isJsonObject(env)) {
    const names = new Set(refusals.variables.map((variable) => variable.name.toUpperCase()));
    for (const name of Object.keys(env)) {
      if (names.has(name.toUpperCase())) out.push(`env.${name}`);
    }
  }
  return out;
}
