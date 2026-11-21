// Loading tools/fin-review/config/*.json. Every file is read and validated before a command does
// anything else; one invalid file makes every command exit 78 (spec 07 §3.2 rule 2).

import { join } from "node:path";
import { parseEnvRefusals } from "./env-refusals.ts";
import type { EnvRefusals } from "./env-refusals.ts";
import { readJsonFile } from "./json.ts";
import { MAX_CONFIG_BYTES, parseDefaultsConfig, parseModelsConfig } from "./options.ts";
import type { ModelsConfig, ReviewOptions } from "./options.ts";
import { parseCiConfig, parseCiMap } from "./plan/ci-map.ts";
import type { CiConfig, CiMap } from "./plan/ci-map.ts";
import { parseFloorConfig } from "./roles.ts";
import type { FloorConfig } from "./roles.ts";
import { parseBudgets } from "./budget.ts";
import type { BudgetsConfig } from "./budget.ts";
import { parseLensesConfig } from "./review/lenses.ts";
import type { LensesConfig } from "./review/lenses.ts";
import { parseClientConfig } from "./runner/client.ts";
import type { ClientConfig } from "./runner/client.ts";

export interface EngineConfig {
  readonly models: ModelsConfig;
  readonly defaults: ReviewOptions;
  readonly floor: FloorConfig;
  readonly envRefusals: EnvRefusals;
  readonly ciMap: CiMap;
  readonly ci: CiConfig;
  readonly client: ClientConfig;
  readonly budgets: BudgetsConfig;
  readonly lenses: LensesConfig;
}

export interface ConfigProblem {
  readonly file: string;
  readonly message: string;
}

export const CONFIG_FILES = [
  "models.json",
  "defaults.json",
  "floor.json",
  "env-refusals.json",
  "ci-map.json",
  "ci.json",
  "client.json",
  "budgets.json",
  "lenses.json",
] as const;

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/** Reads and validates every committed configuration file in `configDir`. */
export function loadEngineConfig(configDir: string): { ok: true; value: EngineConfig } | { ok: false; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const read = <T>(file: string, parse: (value: unknown) => Parsed<T>): T | null => {
    const result = readJsonFile(join(configDir, file), MAX_CONFIG_BYTES);
    if (!result.ok) {
      problems.push({ file, message: result.error });
      return null;
    }
    const parsed = parse(result.value);
    if (!parsed.ok) {
      for (const message of parsed.errors) problems.push({ file, message });
      return null;
    }
    return parsed.value;
  };
  const models = read("models.json", parseModelsConfig);
  const defaults = models === null ? null : read("defaults.json", (value) => parseDefaultsConfig(value, models));
  if (models === null) problems.push({ file: "defaults.json", message: "not checked, because models.json is invalid" });
  const floor = read("floor.json", parseFloorConfig);
  const envRefusals = read("env-refusals.json", parseEnvRefusals);
  const ciMap = read("ci-map.json", parseCiMap);
  const ci = read("ci.json", parseCiConfig);
  const client = read("client.json", parseClientConfig);
  const budgets = read("budgets.json", parseBudgets);
  const lenses = read("lenses.json", parseLensesConfig);
  if (
    problems.length > 0 ||
    models === null ||
    defaults === null ||
    floor === null ||
    envRefusals === null ||
    ciMap === null ||
    ci === null ||
    client === null ||
    budgets === null ||
    lenses === null
  ) {
    return { ok: false, problems };
  }
  return { ok: true, value: Object.freeze({ models, defaults, floor, envRefusals, ciMap, ci, client, budgets, lenses }) };
}
