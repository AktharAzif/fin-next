// One assets-only deployment, uploaded through Cloudflare's API alone (orchestrator decision BD-16,
// on SP-26's result), in the steps SP-26 proved:
//
//   1. POST /accounts/<a>/workers/scripts/<name>/assets-upload-session with the asset manifest;
//      Cloudflare answers an upload token and the buckets of files it does not hold yet;
//   2. POST /accounts/<a>/workers/assets/upload?base64=true per bucket, authorised by the upload
//      token, each file base64-encoded under its hash; the last answer carries the completion token;
//   3. PUT /accounts/<a>/workers/scripts/<name> with ONE multipart part, `metadata`, holding only
//      the compatibility date and `assets: {jwt, config}`: no module, no part of code, no binding,
//      no `run_worker_first`;
//   4. POST /accounts/<a>/workers/scripts/<name>/subdomain {enabled: false, previews_enabled: false};
//   5. the re-read of verify.ts.
//
// Before step 1 the artefact's built files are hashed and compared with the release manifest's
// `assetManifestHash`, so only the attested build is uploaded. Every write first calls `beforeWrite`
// (in `pnpm fin`, the registered run's check), and the function never takes a body from outside:
// what is sent is built here, so no caller can add a module or a binding.

import { readFileSync } from "node:fs";
import { type Artefact, assetManifestHash, uploadManifest } from "./artefact.ts";
import type { StaticClient } from "./cloudflare.ts";
import { checkDeploymentName, type StaticConfig, StaticConfigError } from "./config.ts";
import { verifyDeployment } from "./verify.ts";

export interface DeployOptions {
  client: StaticClient;
  accountId: string;
  name: string;
  config: StaticConfig;
  artefact: Artefact;
  /** The release manifest's assetManifestHash for this deployment. */
  expectedAssetManifestHash: string;
  beforeWrite: (what: string) => void;
  log: (line: string) => void;
}

export interface DeployResult {
  name: string;
  files: number;
  uploaded: number;
  assetManifestHash: string;
}

interface UploadSession {
  jwt?: string;
  buckets?: string[][];
}

/** The script upload's only part: the metadata of an assets-only deployment. */
export function assetsOnlyMetadata(
  config: StaticConfig,
  completionToken: string,
  headers: string,
): Record<string, unknown> {
  return {
    compatibility_date: config.compatibility_date,
    assets: {
      jwt: completionToken,
      config: {
        not_found_handling: config.assets.not_found_handling,
        html_handling: config.assets.html_handling,
        _headers: headers,
      },
    },
  };
}

export async function deployStatic(options: DeployOptions): Promise<DeployResult> {
  const { client, accountId, name, config, artefact } = options;
  checkDeploymentName(name);
  const hash = assetManifestHash(artefact.files);
  if (hash !== options.expectedAssetManifestHash) {
    throw new StaticConfigError(
      `${name}: the artefact's asset manifest hash differs from the release manifest's; refusing to upload`,
    );
  }
  const script = `/accounts/${accountId}/workers/scripts/${name}`;

  options.beforeWrite(`assets upload session ${name}`);
  const session = await client.send<UploadSession>("POST", `${script}/assets-upload-session`, {
    manifest: uploadManifest(artefact.files),
  });
  if (typeof session.jwt !== "string" || session.jwt === "")
    throw new StaticConfigError(`${name}: no upload token in the session`);
  let completion = session.jwt;
  const byHash = new Map(artefact.files.map((f) => [f.hash, f]));
  let uploaded = 0;
  for (const bucket of session.buckets ?? []) {
    const form = new FormData();
    for (const hashOfFile of bucket) {
      const file = byHash.get(hashOfFile);
      if (file === undefined)
        throw new StaticConfigError(
          `${name}: Cloudflare asked for a file the artefact does not hold`,
        );
      form.append(
        file.hash,
        new Blob([readFileSync(file.abs).toString("base64")], { type: file.contentType }),
        file.hash,
      );
      uploaded++;
    }
    options.beforeWrite(`assets bucket ${name}`);
    const answer = await client.uploadBucket<{ jwt?: string } | null>(
      `/accounts/${accountId}/workers/assets/upload?base64=true`,
      session.jwt,
      form,
    );
    if (answer !== null && typeof answer?.jwt === "string" && answer.jwt !== "")
      completion = answer.jwt;
  }
  options.log(`  ${name}: ${artefact.files.length} file(s), ${uploaded} uploaded`);

  const form = new FormData();
  form.append(
    "metadata",
    new Blob([JSON.stringify(assetsOnlyMetadata(config, completion, artefact.headers))], {
      type: "application/json",
    }),
  );
  options.beforeWrite(`assets-only script ${name}`);
  await client.send("PUT", script, form);
  options.beforeWrite(`workers.dev and previews off ${name}`);
  await client.send("POST", `${script}/subdomain`, { enabled: false, previews_enabled: false });

  const problems = await verifyDeployment(client, accountId, name, config);
  if (problems.length > 0) {
    throw new StaticConfigError(
      `${name}: the re-read after the upload differs: ${problems.join("; ")}`,
    );
  }
  options.log(
    `  ${name}: re-read: assets only, no module, no binding, workers.dev and previews off`,
  );
  return { name, files: artefact.files.length, uploaded, assetManifestHash: hash };
}
