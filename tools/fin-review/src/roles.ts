// Session roles, the model and effort each runs on (spec 07 §3.3, [RV-08]), and the effort floor
// a gating run must meet (spec 07 §3.4, [RV-06]).

import { ConfigError } from "./errors.ts";
import { isJsonObject, readJsonFile } from "./json.ts";
import { join } from "node:path";
import {
  EFFORTS,
  MAX_CONFIG_BYTES,
  MODEL_NAMES,
  committedConfigDir,
  effortRank,
  isEffort,
  loadCommittedModels,
  modelIdOf,
} from "./options.ts";
import type { Effort, ModelName, ModelsConfig, ReviewOptions } from "./options.ts";

export type Role =
  | "lens"
  | "joins"
  | "test-truth"
  | "sibling"
  | "sceptic1"
  | "sceptic2"
  | "sceptic3"
  | "second-look"
  | "attack"
  | "doctor";

/** Every role, in the order of spec 07 §3.3. */
export const ROLES: readonly Role[] = [
  "lens",
  "joins",
  "test-truth",
  "sibling",
  "sceptic1",
  "sceptic2",
  "sceptic3",
  "second-look",
  "attack",
  "doctor",
];

/** The roles a gating run may start; the doctor never gates. */
export const GATING_ROLES: readonly Role[] = ROLES.filter((role) => role !== "doctor");

export type Tier = "S" | "N" | "D";
export const TIERS: readonly Tier[] = ["S", "N", "D"];

export interface SessionModel {
  model: ModelName;
  modelId: string;
  effort: Effort;
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isTier(value: unknown): value is Tier {
  return value === "S" || value === "N" || value === "D";
}

/**
 * The model and effort a role's session runs on (spec 07 §3.3):
 * `attack` and `sceptic2` on the attack model at the attack effort, every other reviewing role
 * on the overall model at the overall effort. The doctor checks each allowed model in turn at
 * `high` (see doctorSessions); asked for one session, it gets the overall model at `high`.
 * The switch is exhaustive: a new role without a mapping does not typecheck (T-RV-03).
 */
export function sessionModel(role: Role, o: ReviewOptions, models: ModelsConfig = loadCommittedModels()): SessionModel {
  switch (role) {
    case "attack":
    case "sceptic2":
      return { model: o.attackModel, modelId: modelIdOf(o.attackModel, models), effort: o.attackEffort };
    case "lens":
    case "joins":
    case "test-truth":
    case "sibling":
    case "sceptic1":
    case "sceptic3":
    case "second-look":
      return { model: o.model, modelId: modelIdOf(o.model, models), effort: o.effort };
    case "doctor":
      return { model: o.model, modelId: modelIdOf(o.model, models), effort: "high" };
    default: {
      const unreachable: never = role;
      throw new TypeError(`no model mapping for role ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The doctor's sessions: each allowed model in turn, at `high`, for its checks only. */
export function doctorSessions(models: ModelsConfig = loadCommittedModels()): SessionModel[] {
  return MODEL_NAMES.map((model) => ({ model, modelId: modelIdOf(model, models), effort: "high" }));
}

/** Which option sets a role's effort. */
export function effortFieldOf(role: Role): "effort" | "attackEffort" | null {
  switch (role) {
    case "attack":
    case "sceptic2":
      return "attackEffort";
    case "lens":
    case "joins":
    case "test-truth":
    case "sibling":
    case "sceptic1":
    case "sceptic3":
    case "second-look":
      return "effort";
    case "doctor":
      return null;
    default: {
      const unreachable: never = role;
      throw new TypeError(`no effort field for role ${JSON.stringify(unreachable)}`);
    }
  }
}

// ---- The effort floor ([RV-06]) --------------------------------------------------------------

/** The lowest effort each role may run at on each tier, from config/floor.json. */
export type FloorConfig = Readonly<Record<Tier, Readonly<Record<Role, Effort>>>>;

/**
 * [RV-06]'s default: lens, joins, test-truth, sibling, sceptic1, sceptic3 and second-look at
 * xhigh or max on tier S and high or above elsewhere; attack and sceptic2 at high or above.
 * The committed config/floor.json holds the same table; a test keeps them equal.
 */
export const RV06_DEFAULT_FLOOR: FloorConfig = Object.freeze({
  S: Object.freeze({
    lens: "xhigh",
    joins: "xhigh",
    "test-truth": "xhigh",
    sibling: "xhigh",
    sceptic1: "xhigh",
    sceptic2: "high",
    sceptic3: "xhigh",
    "second-look": "xhigh",
    attack: "high",
    doctor: "high",
  }),
  N: Object.freeze({
    lens: "high",
    joins: "high",
    "test-truth": "high",
    sibling: "high",
    sceptic1: "high",
    sceptic2: "high",
    sceptic3: "high",
    "second-look": "high",
    attack: "high",
    doctor: "high",
  }),
  D: Object.freeze({
    lens: "high",
    joins: "high",
    "test-truth": "high",
    sibling: "high",
    sceptic1: "high",
    sceptic2: "high",
    sceptic3: "high",
    "second-look": "high",
    attack: "high",
    doctor: "high",
  }),
});

/** Validates config/floor.json: `{ "version": 1, "tiers": { S, N, D: { <every role>: effort } } }`. */
export function parseFloorConfig(value: unknown): { ok: true; value: FloorConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "version" && key !== "decision" && key !== "tiers") errors.push(`unknown key ${JSON.stringify(String(key))}`);
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  if (Object.hasOwn(value, "decision") && typeof value["decision"] !== "string") errors.push("decision must be a string");
  const tiers = value["tiers"];
  if (!isJsonObject(tiers)) {
    errors.push("tiers must be an object with S, N and D");
    return { ok: false, errors };
  }
  for (const key of Reflect.ownKeys(tiers)) {
    if (!isTier(key)) errors.push(`tiers has unknown tier ${JSON.stringify(String(key))}`);
  }
  const out: Partial<Record<Tier, Record<Role, Effort>>> = {};
  for (const tier of TIERS) {
    const row = tiers[tier];
    if (!isJsonObject(row)) {
      errors.push(`tiers.${tier} must be an object naming every role`);
      continue;
    }
    for (const key of Reflect.ownKeys(row)) {
      if (!isRole(key)) errors.push(`tiers.${tier} has unknown role ${JSON.stringify(String(key))}`);
    }
    const mapped: Partial<Record<Role, Effort>> = {};
    for (const role of ROLES) {
      const effort = row[role];
      if (!isEffort(effort)) errors.push(`tiers.${tier}.${role} must be one of ${EFFORTS.join(", ")}`);
      else mapped[role] = effort;
    }
    out[tier] = mapped as Record<Role, Effort>;
  }
  if (errors.length > 0) return { ok: false, errors };
  const frozen = {
    S: Object.freeze({ ...(out.S as Record<Role, Effort>) }),
    N: Object.freeze({ ...(out.N as Record<Role, Effort>) }),
    D: Object.freeze({ ...(out.D as Record<Role, Effort>) }),
  };
  return { ok: true, value: Object.freeze(frozen) };
}

/** Reads and validates the committed config/floor.json. Throws ConfigError when invalid. */
export function loadCommittedFloor(): FloorConfig {
  const read = readJsonFile(join(committedConfigDir(), "floor.json"), MAX_CONFIG_BYTES);
  if (!read.ok) throw new ConfigError("floor.json", [read.error]);
  const parsed = parseFloorConfig(read.value);
  if (!parsed.ok) throw new ConfigError("floor.json", parsed.errors);
  return parsed.value;
}

export type FloorCode = "floor_tier_s" | "floor_tier_n" | "floor_tier_d";

export type FloorCheck =
  | { ok: true; minimum: Effort }
  | { ok: false; code: FloorCode; minimum: Effort; message: string };

function floorCode(tier: Tier): FloorCode {
  return tier === "S" ? "floor_tier_s" : tier === "N" ? "floor_tier_n" : "floor_tier_d";
}

/** Whether `role` may run at `effort` on `tier` in a gating run (spec 07 §3.4). */
export function checkFloor(tier: Tier, role: Role, effort: Effort, floor: FloorConfig = loadCommittedFloor()): FloorCheck {
  if (!isTier(tier)) throw new TypeError(`unknown tier ${String(tier)}`);
  if (!isRole(role)) throw new TypeError(`unknown role ${String(role)}`);
  if (!isEffort(effort)) throw new TypeError(`unknown effort ${String(effort)}`);
  const minimum = floor[tier][role];
  if (effortRank(effort) >= effortRank(minimum)) return { ok: true, minimum };
  return {
    ok: false,
    code: floorCode(tier),
    minimum,
    message: `On tier ${tier} the ${role} role needs effort ${minimum} or above, not ${effort} ([RV-06]).`,
  };
}

export interface FloorViolation {
  code: FloorCode;
  field: "effort" | "attackEffort";
  tier: Tier;
  value: Effort;
  minimum: Effort;
  roles: Role[];
  message: string;
}

/**
 * Every floor violation a gating run on `tier` with options `o` would hit, one per option that
 * sets the effort, naming the roles it would start below the floor. Empty when the run may gate.
 */
export function floorViolations(
  tier: Tier,
  o: ReviewOptions,
  floor: FloorConfig = loadCommittedFloor(),
  models: ModelsConfig = loadCommittedModels(),
): FloorViolation[] {
  const byField = new Map<"effort" | "attackEffort", { roles: Role[]; minimum: Effort; value: Effort }>();
  for (const role of GATING_ROLES) {
    const field = effortFieldOf(role);
    if (field === null) continue;
    const { effort } = sessionModel(role, o, models);
    const check = checkFloor(tier, role, effort, floor);
    if (check.ok) continue;
    const entry = byField.get(field);
    if (entry === undefined) byField.set(field, { roles: [role], minimum: check.minimum, value: effort });
    else {
      entry.roles.push(role);
      if (effortRank(check.minimum) > effortRank(entry.minimum)) entry.minimum = check.minimum;
    }
  }
  const out: FloorViolation[] = [];
  for (const field of ["effort", "attackEffort"] as const) {
    const entry = byField.get(field);
    if (entry === undefined) continue;
    const flag = field === "effort" ? "--effort" : "--attack-effort";
    out.push({
      code: floorCode(tier),
      field,
      tier,
      value: entry.value,
      minimum: entry.minimum,
      roles: entry.roles,
      message:
        `${flag} ${entry.value} is below the tier ${tier} floor of ${entry.minimum} for ${entry.roles.join(", ")} ([RV-06]); ` +
        "a gating run is refused, and an --advisory run goes ahead with no receipt.",
    });
  }
  return out;
}
