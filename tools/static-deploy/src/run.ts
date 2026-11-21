// Every static deployment of an environment, in the order the settings give (verify, selfie, admin,
// console, docs: spec 01 §6.9). Every selected deployment is checked first, before the first write
// (its static.json, its rendered build, the build's hash against the release manifest and the two
// rendered files), so a problem anyone could have known in advance never leaves some hosts on the
// new release and some on the old. Then the uploads run in order; a failure stops the run, the hosts
// not yet uploaded keep their previous release, and the summary says which host serves which.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Artefact, assetManifestHash, checkRenderedFiles, readArtefact } from "./artefact.ts";
import type { StaticClient } from "./cloudflare.ts";
import { loadStaticConfig, type StaticConfig, StaticConfigError } from "./config.ts";
import { type DeployResult, deployStatic } from "./deploy.ts";
import { ProvenanceError, parseIdentity, type ReleaseIdentity } from "./provenance.ts";
import { own, type ReleaseManifest } from "./release.ts";

export interface StaticDeployment {
  key: string;
  script: string;
  app: string;
}

export interface EnvironmentStatic {
  name: string;
  order: string[];
  deployments: Record<string, StaticDeployment>;
  /** Who builds and attests this environment's releases (`release` in the settings file). */
  identity: ReleaseIdentity;
}

/** The static part of `ops/environments/<env>.json`, and the release identity. */
export function loadEnvironmentStatic(repoRoot: string, environment: string): EnvironmentStatic {
  let raw: {
    static?: Record<string, { script?: string; app?: string }>;
    staticOrder?: string[];
    release?: unknown;
  };
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
    if (own(deployments, key) === undefined)
      throw new StaticConfigError(`staticOrder names ${key}, which has no deployment`);
  }
  let identity: ReleaseIdentity;
  try {
    identity = parseIdentity(raw.release, `ops/environments/${environment}.json: release`);
  } catch (error) {
    if (error instanceof ProvenanceError) throw new StaticConfigError(error.message);
    throw error;
  }
  return { name: environment, order, deployments, identity };
}

/** A deployment checked and ready to upload. */
export interface PreparedDeployment {
  key: string;
  deployment: StaticDeployment;
  config: StaticConfig;
  artefact: Artefact;
  expectedAssetManifestHash: string;
}

export interface PrepareOptions {
  repoRoot: string;
  environment: EnvironmentStatic;
  manifest: ReleaseManifest;
  /** The rendered artefacts: one directory per deployment key. */
  dir: string;
  only?: string;
}

/** The selected deployment keys, in order. */
export function selectedKeys(environment: EnvironmentStatic, only?: string): string[] {
  const keys = only === undefined ? environment.order : [only];
  for (const key of keys) {
    if (own(environment.deployments, key) === undefined)
      throw new StaticConfigError(`no static deployment named ${key}`);
  }
  return keys;
}

/**
 * Checks every selected deployment before anything is sent: its static.json, its rendered build,
 * the build's asset manifest hash against the release manifest's, and the rendered `_headers` and
 * `env.json`. Any problem refuses the whole run, naming the deployment.
 */
export function prepareStaticDeploy(options: PrepareOptions): PreparedDeployment[] {
  const prepared: PreparedDeployment[] = [];
  for (const key of selectedKeys(options.environment, options.only)) {
    const deployment = own(options.environment.deployments, key);
    if (deployment === undefined) throw new StaticConfigError(`no static deployment named ${key}`);
    const expected = own(options.manifest.static, key);
    if (expected === undefined)
      throw new StaticConfigError(`the release manifest has no static.${key}`);
    try {
      const config = loadStaticConfig(
        join(options.repoRoot, "apps", deployment.app, "static.json"),
      );
      const artefact = readArtefact(join(options.dir, key));
      if (assetManifestHash(artefact.files) !== expected.assetManifestHash) {
        throw new StaticConfigError(
          "the build's asset manifest hash differs from the release manifest's",
        );
      }
      checkRenderedFiles(artefact, options.manifest.commit, options.environment.name);
      prepared.push({
        key,
        deployment,
        config,
        artefact,
        expectedAssetManifestHash: expected.assetManifestHash,
      });
    } catch (error) {
      if (error instanceof StaticConfigError)
        throw new StaticConfigError(`static ${key}: ${error.message}; nothing was uploaded`);
      throw error;
    }
  }
  return prepared;
}

export interface UploadOptions {
  client: StaticClient;
  accountId: string;
  beforeWrite: (what: string) => void;
  log: (line: string) => void;
}

/** The line that says which host serves which release after a stop. */
export function stopSummary(
  stoppedAt: string,
  uploaded: readonly string[],
  notStarted: readonly string[],
): string {
  return `static deploy stopped at ${stoppedAt} (it may serve either release); new release on: ${uploaded.join(", ") || "none"}; previous release still on: ${notStarted.join(", ") || "none"}`;
}

/** Uploads one prepared deployment. */
export function uploadPrepared(
  item: PreparedDeployment,
  options: UploadOptions,
): Promise<DeployResult> {
  options.log(`static ${item.key} -> ${item.deployment.script}`);
  return deployStatic({
    client: options.client,
    accountId: options.accountId,
    name: item.deployment.script,
    config: item.config,
    artefact: item.artefact,
    expectedAssetManifestHash: item.expectedAssetManifestHash,
    beforeWrite: options.beforeWrite,
    log: options.log,
  });
}

export interface RunOptions extends PrepareOptions, UploadOptions {}

export async function runStaticDeploy(options: RunOptions): Promise<DeployResult[]> {
  return uploadAll(prepareStaticDeploy(options), options);
}

/** Uploads prepared deployments in order; on a failure, logs which host serves which release. */
export async function uploadAll(
  prepared: readonly PreparedDeployment[],
  options: UploadOptions,
): Promise<DeployResult[]> {
  const done: DeployResult[] = [];
  for (const [i, item] of prepared.entries()) {
    try {
      done.push(await uploadPrepared(item, options));
    } catch (error) {
      options.log(
        stopSummary(
          item.key,
          prepared.slice(0, i).map((p) => p.key),
          prepared.slice(i + 1).map((p) => p.key),
        ),
      );
      throw error;
    }
  }
  return done;
}
