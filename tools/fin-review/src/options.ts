// The review options and their validator (R11; spec 07 §3.1, §3.2, §3.5, §3.6; [RV-03]).
//
// One validator serves every entry point: the CLI, the configuration files, CI inputs, spool
// requests and receipts. Values are compared exactly: case-sensitive, never trimmed, never
// normalised. Every error is collected, in the order of the six rules.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./errors.ts";
import { isJsonObject, readJsonFile } from "./json.ts";

export type ModelName = "opus" | "fable";
export type Effort = "high" | "xhigh" | "max";
export interface ReviewOptions {
  model: ModelName;
  effort: Effort;
  attackModel: ModelName;
  attackEffort: Effort;
  fast: boolean;
}
export type OptionSource = "cli" | "config" | "ci-input" | "spool" | "receipt";
export type OptionErrorCode =
  | "model_not_allowed"
  | "bare_model_id"
  | "model_unknown"
  | "model_retired"
  | "effort_below_high"
  | "effort_not_allowed"
  | "effort_unknown"
  | "fable_overall_opus_attack"
  | "unknown_option"
  | "duplicate_option"
  | "wrong_type";
export interface OptionError {
  code: OptionErrorCode;
  field: "model" | "effort" | "attackModel" | "attackEffort" | "fast" | "*";
  value: string; // the refused value, at most 40 characters
  message: string;
}

/** The model IDs and the retired list, from config/models.json. */
export interface ModelsConfig {
  readonly opus: string;
  readonly fable: string;
  readonly retired: readonly string[];
}

/** Context that some entry points add; every field is optional. */
export interface ParseContext {
  /** The model IDs; read from the committed config/models.json when absent. */
  readonly models?: ModelsConfig;
  /** Option keys the entry point saw more than once (a CLI flag given twice). */
  readonly duplicates?: readonly string[];
}

export type ParseResult = { ok: true; value: ReviewOptions } | { ok: false; errors: OptionError[] };

export type OptionKey = keyof ReviewOptions;
export type OptionField = OptionError["field"];

export const MODEL_NAMES: readonly ModelName[] = ["opus", "fable"];
export const EFFORTS: readonly Effort[] = ["high", "xhigh", "max"];
export const OPTION_KEYS: readonly OptionKey[] = [
  "model",
  "effort",
  "attackModel",
  "attackEffort",
  "fast",
];
export const OPTION_SOURCES: readonly OptionSource[] = [
  "cli",
  "config",
  "ci-input",
  "spool",
  "receipt",
];

/** The exact message of rule 5 (spec 07 §3.2). */
export const FABLE_OVERALL_OPUS_ATTACK_MESSAGE =
  "With Fable as the overall model the attack pass cannot be Opus (R11).";

/** The CLI flag for each option (spec 07 §3.1). */
export const OPTION_FLAGS: Readonly<Record<OptionKey, string>> = {
  model: "--model",
  effort: "--effort",
  attackModel: "--attack-model",
  attackEffort: "--attack-effort",
  fast: "--fast",
};

/** The CI input name for each option (spec 07 §3.5: review.yml and nightly.yml inputs). */
export const CI_INPUT_NAMES: Readonly<Record<string, OptionKey>> = {
  model: "model",
  effort: "effort",
  "attack-model": "attackModel",
  "attack-effort": "attackEffort",
  fast: "fast",
};

const MODELS_NOT_ALLOWED: ReadonlySet<string> = new Set([
  "sonnet",
  "haiku",
  "opusplan",
  "default",
  "best",
  "auto",
]);
const EFFORTS_BELOW_HIGH: ReadonlySet<string> = new Set(["low", "medium"]);
const EFFORTS_NOT_ALLOWED: ReadonlySet<string> = new Set(["ultracode", "auto", "none", "minimal"]);
const MAX_VALUE_LENGTH = 40;
const MODEL_ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isModelName(value: unknown): value is ModelName {
  return value === "opus" || value === "fable";
}

export function isEffort(value: unknown): value is Effort {
  return value === "high" || value === "xhigh" || value === "max";
}

function isOptionKey(key: string): key is OptionKey {
  return (OPTION_KEYS as readonly string[]).includes(key);
}

/** The rank of an effort: high 0, xhigh 1, max 2. */
export function effortRank(effort: Effort): number {
  return EFFORTS.indexOf(effort);
}

/** The model ID a model name resolves to. */
export function modelIdOf(name: ModelName, models: ModelsConfig): string {
  return name === "opus" ? models.opus : models.fable;
}

/**
 * A printable form of a refused value: characters outside printable ASCII are escaped as
 * \uXXXX (so a terminal never receives a control sequence and a look-alike letter is visible),
 * and the result is cut to at most 40 characters.
 */
export function displayValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") text = value;
  else if (value === null) text = "null";
  else if (Array.isArray(value)) text = "array";
  else if (typeof value === "symbol") text = value.description === undefined ? "symbol" : `symbol ${value.description}`;
  else if (typeof value === "object") text = "object";
  else if (typeof value === "function") text = "function";
  else text = String(value);
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    let piece: string;
    if (code >= 0x20 && code <= 0x7e) piece = ch;
    else if (code <= 0xffff) piece = `\\u${code.toString(16).padStart(4, "0")}`;
    else {
      piece = "";
      for (let i = 0; i < ch.length; i++) piece += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
    if (out.length + piece.length > MAX_VALUE_LENGTH) break;
    out += piece;
  }
  return out;
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

function optionError(code: OptionErrorCode, field: OptionField, value: unknown, message: string): OptionError {
  return { code, field, value: displayValue(value), message };
}

function quoted(value: unknown): string {
  return `"${displayValue(value)}"`;
}

/** Rule 3 for one model value; null when it is valid. */
function checkModel(field: "model" | "attackModel", value: string): OptionError | null {
  if (isModelName(value)) return null;
  if (value.startsWith("claude-") || /[/.:[]/.test(value)) {
    return optionError(
      "bare_model_id",
      field,
      value,
      `${field} ${quoted(value)} is a model ID, not a model name; use opus or fable (R11).`,
    );
  }
  if (MODELS_NOT_ALLOWED.has(value)) {
    return optionError(
      "model_not_allowed",
      field,
      value,
      `${field} ${quoted(value)} is not allowed; only opus or fable may review (R11).`,
    );
  }
  return optionError("model_unknown", field, value, `${field} ${quoted(value)} is not a model; use opus or fable (R11).`);
}

/** Rule 4 for one effort value; null when it is valid. */
function checkEffort(field: "effort" | "attackEffort", value: string): OptionError | null {
  if (isEffort(value)) return null;
  if (EFFORTS_BELOW_HIGH.has(value)) {
    return optionError(
      "effort_below_high",
      field,
      value,
      `${field} ${quoted(value)} is below high; use high, xhigh or max (R11).`,
    );
  }
  if (EFFORTS_NOT_ALLOWED.has(value)) {
    return optionError(
      "effort_not_allowed",
      field,
      value,
      `${field} ${quoted(value)} is not allowed; use high, xhigh or max (R11).`,
    );
  }
  return optionError("effort_unknown", field, value, `${field} ${quoted(value)} is not an effort; use high, xhigh or max (R11).`);
}

const INVALID: unique symbol = Symbol("invalid");
type Slot = unknown | typeof INVALID;

/**
 * The validator. `defaults` null means every key is required (the committed defaults file).
 * Never throws for bad input; throws TypeError only for a programming error.
 */
function validate(
  input: unknown,
  source: OptionSource,
  defaults: ReviewOptions | null,
  models: ModelsConfig,
  duplicates: readonly string[],
): ParseResult {
  const errors: OptionError[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    errors.push(optionError("wrong_type", "*", input, `The options must be an object, not ${typeName(input)}.`));
    return { ok: false, errors };
  }

  // Rule 1: only the five keys, each given once, each of the right type.
  const given = new Map<OptionKey, Slot>();
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== "string" || !isOptionKey(key)) {
      errors.push(optionError("unknown_option", "*", key, `Unknown option ${quoted(key)}.`));
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      errors.push(optionError("wrong_type", key, "accessor", `${key} must be a plain value, not an accessor.`));
      given.set(key, INVALID);
      continue;
    }
    given.set(key, descriptor.value);
  }
  for (const key in input) {
    if (!Object.hasOwn(input, key)) {
      errors.push(optionError("unknown_option", "*", key, `Unknown option ${quoted(key)} (inherited, not the object's own).`));
    }
  }
  const duplicated = new Set<string>(duplicates);
  for (const key of duplicated) {
    if (isOptionKey(key)) {
      errors.push(
        optionError("duplicate_option", key, OPTION_FLAGS[key], `${OPTION_FLAGS[key]} was given more than once.`),
      );
      given.set(key, INVALID);
    } else {
      errors.push(optionError("duplicate_option", "*", key, `${quoted(key)} was given more than once.`));
    }
  }
  for (const key of OPTION_KEYS) {
    if (!given.has(key)) continue;
    const value = given.get(key);
    if (value === INVALID) continue;
    const ok = key === "fast" ? typeof value === "boolean" : typeof value === "string";
    if (!ok) {
      const wanted = key === "fast" ? "a boolean" : "a string";
      const message =
        source === "cli" && value === null
          ? `${OPTION_FLAGS[key]} needs a value.`
          : source === "cli" && key === "fast"
            ? "--fast is a flag and takes no value."
            : `${key} must be ${wanted}, not ${typeName(value)}.`;
      errors.push(optionError("wrong_type", key, value, message));
      given.set(key, INVALID);
    }
  }

  // Rule 2: a missing key takes the default, except in a receipt (and the defaults file itself).
  const resolved = new Map<OptionKey, Slot>();
  for (const key of OPTION_KEYS) {
    if (given.has(key)) {
      resolved.set(key, given.get(key));
      continue;
    }
    if (source === "receipt" || defaults === null) {
      const where = source === "receipt" ? "a receipt records every option" : "the defaults file sets every option";
      errors.push(optionError("wrong_type", key, "", `${key} is missing; ${where}.`));
      resolved.set(key, INVALID);
      continue;
    }
    resolved.set(key, defaults[key]);
  }

  // Rule 3: models.
  for (const field of ["model", "attackModel"] as const) {
    const value = resolved.get(field);
    if (typeof value !== "string") continue;
    const error = checkModel(field, value);
    if (error !== null) {
      errors.push(error);
      resolved.set(field, INVALID);
    }
  }

  // Rule 4: efforts.
  for (const field of ["effort", "attackEffort"] as const) {
    const value = resolved.get(field);
    if (typeof value !== "string") continue;
    const error = checkEffort(field, value);
    if (error !== null) {
      errors.push(error);
      resolved.set(field, INVALID);
    }
  }

  // Rule 5: Fable overall with an Opus attack.
  const model = resolved.get("model");
  const attackModel = resolved.get("attackModel");
  if (model === "fable" && attackModel === "opus") {
    errors.push(optionError("fable_overall_opus_attack", "attackModel", "opus", FABLE_OVERALL_OPUS_ATTACK_MESSAGE));
  }

  // Rule 6: a retired model ID.
  for (const field of ["model", "attackModel"] as const) {
    const value = resolved.get(field);
    if (!isModelName(value)) continue;
    const id = modelIdOf(value, models);
    if (models.retired.includes(id)) {
      errors.push(
        optionError("model_retired", field, id, `${field} ${value} resolves to ${id}, which config/models.json lists as retired.`),
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const effort = resolved.get("effort");
  const attackEffort = resolved.get("attackEffort");
  const fast = resolved.get("fast");
  if (!isModelName(model) || !isModelName(attackModel) || !isEffort(effort) || !isEffort(attackEffort) || typeof fast !== "boolean") {
    throw new TypeError("options validator reached an impossible state");
  }
  return { ok: true, value: Object.freeze({ model, effort, attackModel, attackEffort, fast }) };
}

function assertReviewOptions(value: unknown, what: string): asserts value is ReviewOptions {
  if (
    !isJsonObjectLike(value) ||
    !isModelName(value["model"]) ||
    !isEffort(value["effort"]) ||
    !isModelName(value["attackModel"]) ||
    !isEffort(value["attackEffort"]) ||
    typeof value["fast"] !== "boolean"
  ) {
    throw new TypeError(`${what} must be valid ReviewOptions`);
  }
}

function isJsonObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates review options from one entry point (spec 07 §3.2). `context` may carry the model
 * IDs (read from the committed config/models.json when absent) and the keys the entry point saw
 * twice.
 */
export function parseReviewOptions(
  input: Readonly<Record<string, unknown>>,
  source: OptionSource,
  defaults: ReviewOptions,
  context: ParseContext = {},
): ParseResult {
  if (!OPTION_SOURCES.includes(source)) throw new TypeError(`unknown option source ${String(source)}`);
  assertReviewOptions(defaults, "defaults");
  const models = context.models ?? loadCommittedModels();
  return validate(input, source, defaults, models, context.duplicates ?? []);
}

/**
 * Validates CI inputs (spec 07 §3.5): the `workflow_call` and `workflow_dispatch` inputs `model`,
 * `effort`, `attack-model`, `attack-effort` and `fast`, every one a string. An empty string is an
 * input that was not given (GitHub passes "" for an unset optional input); `fast` must be exactly
 * "true" or "false". Any other input name, camelCase spellings included, is unknown.
 */
export function parseCiInputOptions(
  inputs: Readonly<Record<string, unknown>>,
  defaults: ReviewOptions,
  context: Omit<ParseContext, "duplicates"> = {},
): ParseResult {
  const errors: OptionError[] = [];
  if (typeof inputs !== "object" || inputs === null || Array.isArray(inputs)) {
    return parseReviewOptions(inputs, "ci-input", defaults, context);
  }
  const record = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(inputs)) {
    const option = typeof key === "string" && Object.hasOwn(CI_INPUT_NAMES, key) ? CI_INPUT_NAMES[key] : undefined;
    if (typeof key !== "string" || option === undefined) {
      errors.push(optionError("unknown_option", "*", key, `Unknown CI input ${quoted(key)}.`));
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(inputs, key);
    if (descriptor === undefined) continue;
    let value: unknown = "value" in descriptor ? descriptor.value : descriptor;
    if (value === "") continue;
    if (option === "fast" && value === "true") value = true;
    else if (option === "fast" && value === "false") value = false;
    else if (option === "fast" && typeof value === "string") {
      errors.push(optionError("wrong_type", "fast", value, `CI input fast must be "true" or "false", not ${quoted(value)}.`));
      continue;
    } else if (typeof value !== "string") {
      errors.push(optionError("wrong_type", option, value, `CI input ${key} must be a string, not ${typeName(value)}.`));
      continue;
    }
    record[option] = value;
  }
  for (const key in inputs) {
    if (!Object.hasOwn(inputs, key)) {
      errors.push(optionError("unknown_option", "*", key, `Unknown CI input ${quoted(key)} (inherited, not the object's own).`));
    }
  }
  const result = parseReviewOptions(record, "ci-input", defaults, context);
  if (errors.length === 0) return result;
  return { ok: false, errors: [...errors, ...(result.ok ? [] : result.errors)] };
}

// ---- config/models.json and config/defaults.json --------------------------------------------

/** Validates config/models.json: exactly `opus`, `fable` and `retired`. */
export function parseModelsConfig(value: unknown): { ok: true; value: ModelsConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "opus" && key !== "fable" && key !== "retired") errors.push(`unknown key ${quoted(key)}`);
  }
  const opus = value["opus"];
  const fable = value["fable"];
  const retired = value["retired"];
  if (typeof opus !== "string" || !MODEL_ID_RE.test(opus) || !opus.startsWith("claude-opus-")) {
    errors.push("opus must be a model ID beginning claude-opus-");
  }
  if (typeof fable !== "string" || !MODEL_ID_RE.test(fable) || !fable.startsWith("claude-fable-")) {
    errors.push("fable must be a model ID beginning claude-fable-");
  }
  const retiredList: string[] = [];
  if (!Array.isArray(retired)) errors.push("retired must be an array of model IDs");
  else {
    for (const id of retired) {
      if (typeof id !== "string" || !MODEL_ID_RE.test(id)) errors.push(`retired holds ${quoted(id)}, which is not a model ID`);
      else if (retiredList.includes(id)) errors.push(`retired lists ${id} twice`);
      else retiredList.push(id);
    }
  }
  if (errors.length > 0 || typeof opus !== "string" || typeof fable !== "string") return { ok: false, errors };
  return { ok: true, value: Object.freeze({ opus, fable, retired: Object.freeze(retiredList) }) };
}

/**
 * Validates config/defaults.json: all five options, each valid under R11, the combination
 * allowed and no model retired. An invalid file makes every command exit 78.
 */
export function parseDefaultsConfig(
  value: unknown,
  models: ModelsConfig,
): { ok: true; value: ReviewOptions } | { ok: false; errors: string[] } {
  const result = validate(value, "config", null, models, []);
  if (result.ok) return result;
  return { ok: false, errors: result.errors.map((error) => `${error.code}: ${error.message}`) };
}

/**
 * The machine's local defaults (spec 07 §3.5): the `options` object of
 * `$FIN_REVIEW_HOME/config.json`, the same five keys only, laid over the committed defaults.
 * Other keys of that file belong to other parts of the engine and are not read here.
 */
export function parseMachineOptions(fileValue: unknown, defaults: ReviewOptions, models: ModelsConfig): ParseResult {
  if (!isJsonObject(fileValue)) {
    return { ok: false, errors: [optionError("wrong_type", "*", fileValue, `The machine configuration must be an object, not ${typeName(fileValue)}.`)] };
  }
  if (!Object.hasOwn(fileValue, "options")) return { ok: true, value: defaults };
  const options = fileValue["options"];
  if (!isJsonObject(options)) {
    return { ok: false, errors: [optionError("wrong_type", "*", options, `options must be an object, not ${typeName(options)}.`)] };
  }
  return parseReviewOptions(options, "config", defaults, { models });
}

export const MAX_CONFIG_BYTES = 1 << 20;

/** The engine's committed configuration directory, beside src/. */
export function committedConfigDir(): string {
  return fileURLToPath(new URL("../config/", import.meta.url));
}

/** Reads and validates the committed config/models.json. Throws ConfigError when invalid. */
export function loadCommittedModels(): ModelsConfig {
  const read = readJsonFile(join(committedConfigDir(), "models.json"), MAX_CONFIG_BYTES);
  if (!read.ok) throw new ConfigError("models.json", [read.error]);
  const parsed = parseModelsConfig(read.value);
  if (!parsed.ok) throw new ConfigError("models.json", parsed.errors);
  return parsed.value;
}

/** Reads and validates the committed config/defaults.json. Throws ConfigError when invalid. */
export function loadCommittedDefaults(models: ModelsConfig = loadCommittedModels()): ReviewOptions {
  const read = readJsonFile(join(committedConfigDir(), "defaults.json"), MAX_CONFIG_BYTES);
  if (!read.ok) throw new ConfigError("defaults.json", [read.error]);
  const parsed = parseDefaultsConfig(read.value, models);
  if (!parsed.ok) throw new ConfigError("defaults.json", parsed.errors);
  return parsed.value;
}
