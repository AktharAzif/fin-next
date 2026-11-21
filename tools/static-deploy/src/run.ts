// Every static deployment of an environment, in the order the settings give (verify, selfie, admin,
// console, docs: spec 01 §6.9). A failure stops the run; the hosts not yet uploaded keep their
// previous release, and the summary says which host serves which release.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readArtefact } from "./artefact.ts";
import type { StaticClient } from "./cloudflare.ts";
import { loadStaticConfig, StaticConfigError } from "./config.ts";
import { type DeployResult, deployStatic } from "./deploy.ts";
import type { ReleaseManifest } from "./release.ts";

export interface StaticDeployment {
  key: string;
  script: string;
  app: string;
}

export interface EnvironmentStatic {
  order: string[];
  deployments: Record<string, StaticDeployment>;
}

/** The static part of `ops/environments/<env>.json`. */
export function loadEnvironmentStatic(repoRoot: string, environment: string): EnvironmentStatic {
  let raw: { static?: Record<string, { script?: string; app?: string }>; staticOrder?: string[] };
  try {
    raw = JSON.parse(
      readFileSync(join(repoRoot, "ops", "environments", `${environment}.json`), "utf8"),
    );
  } catch {
    throw new StaticConfigError(
      `ops/environments/${environment}.json is missing or not valid JSON`,
    );
  }
  const deployments: Record<string, StaticDeployment> = {};
  for (const [key, entry] of Object.entries(raw.static ?? {})) {
    if (
      typeof entry.script !== "string" ||
      typeof entry.app !== "string" ||
      !/^[a-z]+$/.test(entry.app)
    ) {
      throw new StaticConfigError(
        `ops/environments/${environment}.json: static.${key} is malformed`,
      );
    }
    deployments[key] = { key, script: entry.script, app: entry.app };
  }
  const order = raw.staticOrder ?? [];
  for (const key of order) {
    if (deployments[key] === undefined)
      throw new StaticConfigError(`staticOrder names ${key}, which has no deployment`);
  }
  return { order, deployments };
}

export interface RunOptions {
  client: StaticClient;
  accountId: string;
  repoRoot: string;
  environment: EnvironmentStatic;
  manifest: ReleaseManifest;
  /** The rendered artefacts: one directory per deployment key. */
  dir: string;
  only?: string;
  beforeWrite: (what: string) => void;
  log: (line: string) => void;
}

export async function runStaticDeploy(options: RunOptions): Promise<DeployResult[]> {
  const keys = options.only === undefined ? options.environment.order : [options.only];
  const done: DeployResult[] = [];
  for (const key of keys) {
    const deployment = options.environment.deployments[key];
    if (deployment === undefined) throw new StaticConfigError(`no static deployment named ${key}`);
    const expected = options.manifest.static[key];
    if (expected === undefined)
      throw new StaticConfigError(`the release manifest has no static.${key}`);
    const config = loadStaticConfig(join(options.repoRoot, "apps", deployment.app, "static.json"));
    const artefact = readArtefact(join(options.dir, key));
    try {
      options.log(`static ${key} -> ${deployment.script}`);
      done.push(
        await deployStatic({
          client: options.client,
          accountId: options.accountId,
          name: deployment.script,
          config,
          artefact,
          expectedAssetManifestHash: expected.assetManifestHash,
          beforeWrite: options.beforeWrite,
          log: options.log,
        }),
      );
    } catch (error) {
      const left = keys.slice(keys.indexOf(key));
      options.log(
        `static deploy stopped at ${key}; new release on: ${done.map((d) => d.name).join(", ") || "none"}; previous release still on: ${left.join(", ")}`,
      );
      throw error;
    }
  }
  return done;
}
