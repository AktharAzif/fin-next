// Session and run budgets (spec 07 §4.1, §5.6; [RV-13]): config/budgets.json, and the run's spend.
//
// A session's cap is passed as --max-budget-usd. A run that has reached its cap starts no new
// session, and its unfinished lenses become budget_reached: "could not check", never a pass.

import { isJsonObject } from "./json.ts";
import { ROLES, TIERS } from "./roles.ts";
import type { Role, Tier } from "./roles.ts";

export interface BudgetsConfig {
  readonly sessionUsd: Readonly<Record<Role, number>>;
  readonly maxTurns: Readonly<Record<Role, number>>;
  readonly timeoutMinutes: Readonly<Record<Role, number>>;
  readonly runUsd: { readonly commit: number; readonly pr: Readonly<Record<Tier, number>> };
}

function positive(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function roleTable(value: unknown, what: string, max: number, integer: boolean, errors: string[]): Record<Role, number> | null {
  if (!isJsonObject(value)) {
    errors.push(`${what} must be an object naming every role`);
    return null;
  }
  for (const key of Object.keys(value)) if (!(ROLES as readonly string[]).includes(key)) errors.push(`${what} has unknown role ${JSON.stringify(key)}`);
  const out: Partial<Record<Role, number>> = {};
  for (const role of ROLES) {
    const item = value[role];
    if (!positive(item, max) || (integer && !Number.isInteger(item))) errors.push(`${what}.${role} must be a positive ${integer ? "integer" : "number"} up to ${max}`);
    else out[role] = item;
  }
  return out as Record<Role, number>;
}

/** Validates config/budgets.json. */
export function parseBudgets(value: unknown): { ok: true; value: BudgetsConfig } | { ok: false; errors: string[] } {
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  const errors: string[] = [];
  for (const key of Object.keys(value)) {
    if (!["version", "note", "sessionUsd", "maxTurns", "timeoutMinutes", "runUsd"].includes(key)) errors.push(`unknown key ${JSON.stringify(key)}`);
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  const sessionUsd = roleTable(value["sessionUsd"], "sessionUsd", 100, false, errors);
  const maxTurns = roleTable(value["maxTurns"], "maxTurns", 500, true, errors);
  const timeoutMinutes = roleTable(value["timeoutMinutes"], "timeoutMinutes", 180, true, errors);
  const run = value["runUsd"];
  let runUsd: BudgetsConfig["runUsd"] | null = null;
  if (!isJsonObject(run)) errors.push("runUsd must be an object with commit and pr");
  else {
    for (const key of Object.keys(run)) if (key !== "commit" && key !== "pr") errors.push(`runUsd has unknown key ${JSON.stringify(key)}`);
    const commit = run["commit"];
    const pr = run["pr"];
    if (!positive(commit, 10_000)) errors.push("runUsd.commit must be a positive number");
    const prOut: Partial<Record<Tier, number>> = {};
    if (!isJsonObject(pr)) errors.push("runUsd.pr must be an object with S, N and D");
    else {
      for (const key of Object.keys(pr)) if (!(TIERS as readonly string[]).includes(key)) errors.push(`runUsd.pr has unknown tier ${JSON.stringify(key)}`);
      for (const tier of TIERS) {
        const cap = pr[tier];
        if (!positive(cap, 10_000)) errors.push(`runUsd.pr.${tier} must be a positive number`);
        else prOut[tier] = cap;
      }
    }
    if (positive(commit, 10_000)) runUsd = { commit, pr: prOut as Record<Tier, number> };
  }
  if (errors.length > 0 || sessionUsd === null || maxTurns === null || timeoutMinutes === null || runUsd === null) return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze({
      sessionUsd: Object.freeze(sessionUsd),
      maxTurns: Object.freeze(maxTurns),
      timeoutMinutes: Object.freeze(timeoutMinutes),
      runUsd: Object.freeze({ commit: runUsd.commit, pr: Object.freeze({ ...runUsd.pr }) }),
    }),
  };
}

/** USD to integer micro-USD. */
export function microUsd(usd: number): number {
  return Math.round(usd * 1_000_000);
}

/** The run's spend against its cap. */
export class RunBudget {
  readonly capMicroUsd: number;
  private spent = 0;

  constructor(capUsd: number) {
    if (!positive(capUsd, 10_000)) throw new TypeError("a run cap must be a positive number of USD");
    this.capMicroUsd = microUsd(capUsd);
  }

  add(micro: number): void {
    if (!Number.isInteger(micro) || micro < 0) throw new TypeError("spend must be a non-negative integer of micro-USD");
    this.spent += micro;
  }

  get spentMicroUsd(): number {
    return this.spent;
  }

  /** True once the run has spent its cap; no new session may start. */
  reached(): boolean {
    return this.spent >= this.capMicroUsd;
  }
}
