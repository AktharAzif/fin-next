// `pnpm fin static deploy <env> --release <sha> --manifest <file> --dir <rendered>` (BD-16; spec 01
// §6.9 steps 3 and 4, §7.4): the operator machine's way to upload the rendered static builds (BD-05:
// staging deploys run from the operator machine today), with the same code the CI job runs
// (tools/static-deploy), inside a registered run. Each deployment's built files must hash to the
// release manifest's `assetManifestHash`; each upload is an assets-only deployment (one metadata
// part, no module, no binding), then workers.dev and previews off, then the re-read.
//
// The token is the static deploy token (CR-20, FIN_CF_STATIC_TOKEN_FILE). On the operator machine
// the operator token may stand in when no static token exists (FIN_CF_TOKEN_FILE, with a warning).

import {
  CloudflareCallError,
  cloudflareClient,
} from "../../../../tools/static-deploy/src/cloudflare.ts";
import { StaticConfigError } from "../../../../tools/static-deploy/src/config.ts";
import {
  loadReleaseManifest,
  type ReleaseManifest,
} from "../../../../tools/static-deploy/src/release.ts";
import { loadEnvironmentStatic, runStaticDeploy } from "../../../../tools/static-deploy/src/run.ts";
import type { Command } from "../command.ts";
import { flagString } from "../core/args.ts";
import { hasCredential } from "../core/credentials.ts";
import { DataError, ProviderError, UsageError } from "../core/errors.ts";
import type { Change } from "../core/plan.ts";

const SHA = /^[0-9a-f]{40}$/;

function translate(error: unknown): unknown {
  if (error instanceof StaticConfigError) return new DataError(error.message);
  if (error instanceof CloudflareCallError)
    return new ProviderError("cloudflare", error.message, error.status);
  return error;
}

export const staticDeploy: Command = {
  words: ["static", "deploy"],
  summary: "upload the rendered static builds as assets-only deployments (no wrangler, BD-16)",
  positionals: [],
  flags: [
    { name: "release", kind: "string", description: "the release's full commit SHA" },
    {
      name: "manifest",
      kind: "string",
      description: "the release manifest (release-manifest.json)",
    },
    {
      name: "dir",
      kind: "string",
      description: "the rendered builds (pnpm fin static render --out)",
    },
    { name: "only", kind: "string", description: "upload one deployment only" },
  ],
  overlay: true,
  mutating: true,
  runbook: "static-deploy.md",
  async run(ctx) {
    const release = flagString(ctx.args, "release") ?? "";
    const manifestFile = flagString(ctx.args, "manifest");
    const dir = flagString(ctx.args, "dir");
    if (!SHA.test(release))
      throw new UsageError("--release must be the full 40-character commit SHA");
    if (manifestFile === undefined || dir === undefined)
      throw new UsageError("--manifest and --dir are required");
    const only = flagString(ctx.args, "only");
    const keys = only === undefined ? ctx.settings.staticOrder : [only];
    let manifest: ReleaseManifest;
    try {
      manifest = loadReleaseManifest(manifestFile, release);
    } catch (error) {
      throw translate(error);
    }
    const changes: Change[] = [];
    for (const key of keys) {
      const s = ctx.settings.static[key];
      if (s === undefined) throw new UsageError(`no static deployment named ${key}`);
      ctx.guard.checkOwnName(s.script, "static deployment");
      if (manifest.static[key] === undefined)
        throw new DataError(`the release manifest has no static.${key}`);
      changes.push({
        kind: "static",
        name: s.script,
        action: "update",
        detail: `release ${release.slice(0, 12)}, assets only`,
      });
    }
    let variable: "FIN_CF_STATIC_TOKEN_FILE" | "FIN_CF_TOKEN_FILE" = "FIN_CF_STATIC_TOKEN_FILE";
    if (!hasCredential(ctx.runtime.env, variable)) {
      variable = "FIN_CF_TOKEN_FILE";
      ctx.out.warn(
        "FIN_CF_STATIC_TOKEN_FILE is not set; the operator token stands in for the static deploy token",
      );
    }
    const token = ctx.dryRun ? undefined : ctx.credential(variable);
    const environment = loadEnvironmentStatic(ctx.runtime.repoRoot, ctx.environment);
    return ctx.applyPlan(
      "static deploy",
      changes,
      async (change) => {
        const key = keys.find((k) => ctx.settings.static[k]?.script === change.name);
        if (key === undefined || token === undefined) return;
        try {
          const [result] = await runStaticDeploy({
            client: cloudflareClient(token.reveal(), ctx.runtime.fetch),
            accountId: ctx.overlay.cloudflare.accountId,
            repoRoot: ctx.runtime.repoRoot,
            environment,
            manifest,
            dir,
            only: key,
            beforeWrite: (what) => ctx.run.assertWritable(what),
            log: (line) => ctx.out.info(line),
          });
          ctx.run.line("deploy.static_step", "info", {
            deployment: change.name,
            release,
            files: result?.files ?? 0,
            uploaded: result?.uploaded ?? 0,
            assetManifestHash: result?.assetManifestHash ?? null,
          });
        } catch (error) {
          ctx.run.line("deploy.failed", "error", { step: `static ${key}`, release });
          throw translate(error);
        }
      },
      { release },
      async () => {
        ctx.run.line("deploy.static_done", "info", { release, deployments: changes.length });
        return {};
      },
    );
  },
};
