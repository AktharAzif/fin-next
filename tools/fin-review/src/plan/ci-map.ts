// CI path classes (spec 07 §10.1, §10.2; spec 01 §5.3), from config/ci-map.json, and the CI
// settings of config/ci.json.
//
// A path belongs to every class whose `paths` match it and whose `exclude` does not; a path no
// class takes is `unmapped`, which, like the `global` class, runs everything.

import { isJsonObject } from "../json.ts";
import { compileGlob, globError, matchesAny } from "./glob.ts";
import type { Glob } from "./glob.ts";

export const JOB_NAMES = ["check", "db", "build", "seams", "e2e", "static", "bun", "containers"] as const;
export type JobName = (typeof JOB_NAMES)[number];

export const CLASS_NAMES = ["global", "docs", "db", "server", "client", "docker", "ops", "contract", "scripts"] as const;
export type ClassName = (typeof CLASS_NAMES)[number];
export const UNMAPPED = "unmapped";

/** Which e2e apps a class turns on: every one, the affected ones, or the listed app folders. */
export type E2eSelection = { kind: "none" } | { kind: "every" } | { kind: "affected" } | { kind: "apps"; apps: readonly string[] };

export interface CiClass {
  readonly name: ClassName;
  readonly everything: boolean;
  readonly jobs: ReadonlySet<JobName>;
  readonly paths: readonly Glob[];
  readonly exclude: readonly Glob[];
  /** Patterns of `paths` that may match no tracked file yet (T-RV-21). */
  readonly planned: ReadonlySet<string>;
  readonly e2e: E2eSelection;
  /** Paths of this class whose change runs every app's e2e (a design-system package). */
  readonly e2eEvery: readonly Glob[];
  /** The `db` job also runs when a changed package has a *.db.test.ts or depends on the db package. */
  readonly dbWhenPackageNeedsDb: boolean;
}

export interface CiMap {
  readonly classes: readonly CiClass[];
  /** Jobs that run on every plan. */
  readonly always: ReadonlySet<JobName>;
}

export interface CiConfig {
  /** Playwright shards when e2e runs (spec 07 §10.4). */
  readonly e2eShards: number;
  /** The web apps with e2e projects, as package folders (apps/console). */
  readonly e2eApps: readonly string[];
  /** Globs of workspace package folders; a folder is a package when it holds package.json. */
  readonly workspaces: readonly Glob[];
  readonly workspacePatterns: readonly string[];
  /** Top folders where a changed path outside any package means everything (spec 07 §10.2). */
  readonly packageRoots: readonly string[];
  /** The database package; depending on it turns on the db job. */
  readonly dbPackage: string;
  /** Paths whose change turns on the non-blocking Bun canary (spec 01 §5.3). */
  readonly bun: readonly Glob[];
}

function isJobName(value: unknown): value is JobName {
  return typeof value === "string" && (JOB_NAMES as readonly string[]).includes(value);
}

function isClassName(value: unknown): value is ClassName {
  return typeof value === "string" && (CLASS_NAMES as readonly string[]).includes(value);
}

function globList(value: unknown, where: string, errors: string[], allowEmpty: boolean): Glob[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    errors.push(`${where} must be ${allowEmpty ? "an" : "a non-empty"} array of globs`);
    return [];
  }
  const out: Glob[] = [];
  const seen = new Set<string>();
  value.forEach((item, index) => {
    const problem = globError(item);
    if (problem !== null) {
      errors.push(`${where}[${index}]: ${problem}`);
      return;
    }
    const pattern = item as string;
    if (seen.has(pattern)) errors.push(`${where} lists ${JSON.stringify(pattern)} twice`);
    seen.add(pattern);
    out.push(compileGlob(pattern));
  });
  return out;
}

const CLASS_KEYS = new Set(["name", "note", "everything", "jobs", "paths", "exclude", "planned", "e2e", "e2eEvery", "dbWhen"]);
const APP_DIR_RE = /^apps\/[a-z0-9][a-z0-9-]*$/;

/** Validates config/ci-map.json. */
export function parseCiMap(value: unknown): { ok: true; value: CiMap } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "version" && key !== "note" && key !== "always" && key !== "classes") errors.push(`unknown key ${JSON.stringify(String(key))}`);
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  const always = new Set<JobName>();
  const rawAlways = value["always"];
  if (!Array.isArray(rawAlways)) errors.push("always must be an array of job names");
  else for (const job of rawAlways) {
    if (!isJobName(job)) errors.push(`always holds ${JSON.stringify(job)}, which is not a job`);
    else if (job === "e2e" || job === "bun") errors.push(`always may not hold ${job}; its own rule decides it`);
    else always.add(job);
  }
  const classes: CiClass[] = [];
  const rawClasses = value["classes"];
  const seen = new Set<string>();
  if (!Array.isArray(rawClasses)) errors.push("classes must be an array");
  else {
    rawClasses.forEach((raw, index) => {
      const where = `classes[${index}]`;
      if (!isJsonObject(raw)) {
        errors.push(`${where} must be an object`);
        return;
      }
      for (const key of Reflect.ownKeys(raw)) {
        if (typeof key !== "string" || !CLASS_KEYS.has(key)) errors.push(`${where} has unknown key ${JSON.stringify(String(key))}`);
      }
      const name = raw["name"];
      if (!isClassName(name)) {
        errors.push(`${where}.name must be one of ${CLASS_NAMES.join(", ")}`);
        return;
      }
      if (seen.has(name)) errors.push(`class ${name} appears twice`);
      seen.add(name);
      if (Object.hasOwn(raw, "note") && typeof raw["note"] !== "string") errors.push(`${where}.note must be a string`);
      const everything = raw["everything"] === true;
      if (Object.hasOwn(raw, "everything") && typeof raw["everything"] !== "boolean") errors.push(`${where}.everything must be a boolean`);
      const jobs = new Set<JobName>();
      const rawJobs = raw["jobs"];
      if (everything) {
        if (Object.hasOwn(raw, "jobs")) errors.push(`${where} runs everything, so it lists no jobs`);
      } else if (!Array.isArray(rawJobs) || rawJobs.length === 0) errors.push(`${where}.jobs must be a non-empty array`);
      else for (const job of rawJobs) {
        if (!isJobName(job)) errors.push(`${where}.jobs holds ${JSON.stringify(job)}, which is not a job`);
        else if (job === "bun") errors.push(`${where}.jobs may not hold bun; config/ci.json's bun paths decide it`);
        else jobs.add(job);
      }
      const paths = globList(raw["paths"], `${where}.paths`, errors, false);
      const exclude = Object.hasOwn(raw, "exclude") ? globList(raw["exclude"], `${where}.exclude`, errors, true) : [];
      const planned = new Set<string>();
      if (Object.hasOwn(raw, "planned")) {
        const rawPlanned = raw["planned"];
        if (!Array.isArray(rawPlanned)) errors.push(`${where}.planned must be an array`);
        else for (const item of rawPlanned) {
          if (typeof item !== "string" || !paths.some((glob) => glob.pattern === item)) {
            errors.push(`${where}.planned holds ${JSON.stringify(item)}, which is not one of its paths`);
          } else planned.add(item);
        }
      }
      let e2e: E2eSelection = { kind: "none" };
      const rawE2e = raw["e2e"];
      if (jobs.has("e2e")) {
        if (rawE2e === "every") e2e = { kind: "every" };
        else if (rawE2e === "affected") e2e = { kind: "affected" };
        else if (Array.isArray(rawE2e) && rawE2e.length > 0 && rawE2e.every((app) => typeof app === "string" && APP_DIR_RE.test(app))) {
          e2e = { kind: "apps", apps: Object.freeze([...(rawE2e as string[])]) };
        } else errors.push(`${where}.e2e must be "every", "affected" or a list of app folders, because it runs e2e`);
      } else if (Object.hasOwn(raw, "e2e")) errors.push(`${where}.e2e is only for a class that runs e2e`);
      let e2eEvery: Glob[] = [];
      if (Object.hasOwn(raw, "e2eEvery")) {
        if (e2e.kind !== "affected") errors.push(`${where}.e2eEvery is only for a class whose e2e is "affected"`);
        e2eEvery = globList(raw["e2eEvery"], `${where}.e2eEvery`, errors, false);
      }
      let dbWhenPackageNeedsDb = false;
      if (Object.hasOwn(raw, "dbWhen")) {
        if (raw["dbWhen"] === "package-needs-db") dbWhenPackageNeedsDb = true;
        else errors.push(`${where}.dbWhen must be "package-needs-db"`);
      }
      classes.push(
        Object.freeze({ name, everything, jobs, paths: Object.freeze(paths), exclude: Object.freeze(exclude), planned, e2e, e2eEvery: Object.freeze(e2eEvery), dbWhenPackageNeedsDb }),
      );
    });
  }
  for (const name of CLASS_NAMES) if (!seen.has(name)) errors.push(`class ${name} is missing`);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: Object.freeze({ classes: Object.freeze(classes), always }) };
}

const CI_KEYS = new Set(["version", "note", "e2eShards", "e2eApps", "workspaces", "packageRoots", "dbPackage", "bun"]);
const PACKAGE_NAME_RE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$|^[a-z0-9][a-z0-9._-]*$/;
const ROOT_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Validates config/ci.json. */
export function parseCiConfig(value: unknown): { ok: true; value: CiConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isJsonObject(value)) return { ok: false, errors: ["must be a JSON object"] };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !CI_KEYS.has(key)) errors.push(`unknown key ${JSON.stringify(String(key))}`);
  }
  if (value["version"] !== 1) errors.push("version must be 1");
  const shards = value["e2eShards"];
  if (typeof shards !== "number" || !Number.isInteger(shards) || shards < 1 || shards > 32) {
    errors.push("e2eShards must be an integer from 1 to 32");
  }
  const e2eApps: string[] = [];
  const rawApps = value["e2eApps"];
  if (!Array.isArray(rawApps)) errors.push("e2eApps must be an array of app folders");
  else for (const app of rawApps) {
    if (typeof app !== "string" || !APP_DIR_RE.test(app)) errors.push(`e2eApps holds ${JSON.stringify(app)}, which is not an app folder`);
    else if (e2eApps.includes(app)) errors.push(`e2eApps lists ${app} twice`);
    else e2eApps.push(app);
  }
  const rawWorkspaces = value["workspaces"];
  const workspaces = globList(rawWorkspaces, "workspaces", errors, false);
  for (const glob of workspaces) {
    if (glob.pattern.includes("**")) errors.push(`workspaces glob ${JSON.stringify(glob.pattern)} may not use **`);
  }
  const packageRoots: string[] = [];
  const rawRoots = value["packageRoots"];
  if (!Array.isArray(rawRoots)) errors.push("packageRoots must be an array of top folders");
  else for (const root of rawRoots) {
    if (typeof root !== "string" || !ROOT_RE.test(root)) errors.push(`packageRoots holds ${JSON.stringify(root)}`);
    else packageRoots.push(root);
  }
  const dbPackage = value["dbPackage"];
  if (typeof dbPackage !== "string" || !PACKAGE_NAME_RE.test(dbPackage)) errors.push("dbPackage must be a package name");
  const bun = globList(value["bun"], "bun", errors, false);
  if (errors.length > 0 || typeof shards !== "number" || typeof dbPackage !== "string") return { ok: false, errors };
  return {
    ok: true,
    value: Object.freeze({
      e2eShards: shards,
      e2eApps: Object.freeze(e2eApps),
      workspaces: Object.freeze(workspaces),
      workspacePatterns: Object.freeze(workspaces.map((glob) => glob.pattern)),
      packageRoots: Object.freeze(packageRoots),
      dbPackage,
      bun: Object.freeze(bun),
    }),
  };
}

/** The classes of one path, in config order; empty means unmapped. */
export function classesOf(map: CiMap, path: string): CiClass[] {
  const out: CiClass[] = [];
  for (const cls of map.classes) {
    if (matchesAny(cls.paths, path) && !matchesAny(cls.exclude, path)) out.push(cls);
  }
  return out;
}
