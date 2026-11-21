// The required lenses per tier (spec 07 §2.6), from config/lenses.json: one file that the planner
// and (later) the checker read, so both require the same set (T-RV-18).

import { isJsonObject } from "../json.ts";
import { compileGlob, globError, matchesAny } from "../plan/glob.ts";
import type { Glob } from "../plan/glob.ts";
import { TIERS, isTier } from "../roles.ts";
import type { Tier } from "../roles.ts";

/** The lenses this engine can run, in the order sessions are planned. */
export const LENSES = ["correctness", "security", "quality", "performance", "rules", "joins", "test-truth", "infra", "dependency"] as const;
export type Lens = (typeof LENSES)[number];

export function isLens(value: unknown): value is Lens {
  return typeof value === "string" && (LENSES as readonly string[]).includes(value);
}

export interface ConditionalLens {
  readonly lens: Lens;
  readonly tiers: readonly Tier[];
  readonly paths: readonly Glob[];
}

export interface LensesConfig {
  readonly tiers: Readonly<Record<Tier, { readonly always: readonly Lens[]; readonly attack: boolean }>>;
  readonly conditional: readonly ConditionalLens[];
}

/** Validates config/lenses.json. */
export function parseLensesConfig(value: unknown): { ok: true; value: LensesConfig } | { ok: false; errors: string[] } {
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) if (!["version", "note", "tiers", "conditional"].includes(key)) errors.push(`unknown key ${JSON.stringify(key)}`);
  if (value["version"] !== 1) errors.push("version must be 1");
  const tiers: Partial<Record<Tier, { always: Lens[]; attack: boolean }>> = {};
  const rawTiers = value["tiers"];
  if (!isJsonObject(rawTiers)) errors.push("tiers must be an object with S, N and D");
  else {
    for (const key of Object.keys(rawTiers)) if (!isTier(key)) errors.push(`tiers has unknown tier ${JSON.stringify(key)}`);
    for (const tier of TIERS) {
      const row = rawTiers[tier];
      if (!isJsonObject(row)) {
        errors.push(`tiers.${tier} must be an object`);
        continue;
      }
      for (const key of Object.keys(row)) if (key !== "always" && key !== "attack") errors.push(`tiers.${tier} has unknown key ${JSON.stringify(key)}`);
      const always = row["always"];
      const attack = row["attack"];
      if (!Array.isArray(always) || always.length === 0 || !always.every(isLens) || new Set(always).size !== always.length) {
        errors.push(`tiers.${tier}.always must be a non-empty list of distinct lenses`);
        continue;
      }
      if (typeof attack !== "boolean") errors.push(`tiers.${tier}.attack must be a boolean`);
      tiers[tier] = { always: always as Lens[], attack: attack === true };
    }
    if (tiers.S !== undefined && !tiers.S.attack) errors.push("tiers.S.attack must be true: the attack pass is never switched off on tier S ([RV-07])");
    for (const tier of ["N", "D"] as const) if (tiers[tier]?.attack === true) errors.push(`tiers.${tier}.attack must be false: the attack pass runs on tier S only`);
  }
  const conditional: ConditionalLens[] = [];
  const rawConditional = value["conditional"];
  if (!Array.isArray(rawConditional)) errors.push("conditional must be an array");
  else {
    rawConditional.forEach((entry, index) => {
      const where = `conditional[${index}]`;
      if (!isJsonObject(entry)) {
        errors.push(`${where} must be an object`);
        return;
      }
      for (const key of Object.keys(entry)) if (!["lens", "tiers", "paths", "note"].includes(key)) errors.push(`${where} has unknown key ${JSON.stringify(key)}`);
      const lens = entry["lens"];
      const entryTiers = entry["tiers"];
      const paths = entry["paths"];
      if (!isLens(lens)) {
        errors.push(`${where}.lens must be a lens`);
        return;
      }
      if (!Array.isArray(entryTiers) || entryTiers.length === 0 || !entryTiers.every(isTier)) {
        errors.push(`${where}.tiers must be a non-empty list of tiers`);
        return;
      }
      if (!Array.isArray(paths) || paths.length === 0) {
        errors.push(`${where}.paths must be a non-empty list of globs`);
        return;
      }
      const globs: Glob[] = [];
      for (const pattern of paths) {
        const problem = globError(pattern);
        if (problem !== null) errors.push(`${where}.paths: ${problem}`);
        else globs.push(compileGlob(pattern as string));
      }
      conditional.push(Object.freeze({ lens, tiers: Object.freeze([...entryTiers] as Tier[]), paths: Object.freeze(globs) }));
    });
  }
  if (errors.length > 0 || tiers.S === undefined || tiers.N === undefined || tiers.D === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze({
      tiers: Object.freeze({ S: Object.freeze(tiers.S), N: Object.freeze(tiers.N), D: Object.freeze(tiers.D) }),
      conditional: Object.freeze(conditional),
    }),
  };
}

/** The lenses a change of `tier` with these changed paths requires, in LENSES order. */
export function requiredLenses(config: LensesConfig, tier: Tier, paths: readonly string[]): Lens[] {
  const set = new Set<Lens>(config.tiers[tier].always);
  for (const entry of config.conditional) {
    if (!entry.tiers.includes(tier)) continue;
    if (paths.some((path) => matchesAny(entry.paths, path))) set.add(entry.lens);
  }
  return LENSES.filter((lens) => set.has(lens));
}

/** Whether a change of `tier` gets the attack pass. */
export function attackRequired(config: LensesConfig, tier: Tier): boolean {
  return config.tiers[tier].attack;
}
