// `pnpm fin static deploy <env> --release <sha> --manifest <file> --dir <rendered>` (BD-16; spec 01
// §6.9 `deploy-static-staging` on the operator machine (BD-05), §7.4): uploads the builds
// `pnpm fin static render` wrote, with the same code the CI job runs (tools/static-deploy), inside a
// registered run.
//
// Before any write, and so in a dry run too: ci.yml's `merge` job succeeded for the commit (spec 01
// §6.9 step 2: release.yml is the pushed commit's own workflow, so the merge job is what says the
// commit was reviewed); the release manifest's attestation verifies; the services run the release
// now, so a new page never meets an old API (S0-06, FW-C13): the newest registered `railway deploy`
// in this machine's run log is a successful one of the release, and Railway says that every
// service a deploy rolls has a newest deployment that ended SUCCESS on the manifest's digest (a
// past deploy of the release proves nothing once a later one, a failed one or a change by hand has
// moved the services). Only `--static-rollback`, which puts an earlier release's pages back ahead
// of its services and which the run records, skips that; a deployment image Railway did not say
// refuses unless the operator checked it and passes `--accept-unchecked-deployments` (recorded).
// Then every selected deployment is checked (its
// static.json, its build's hash against that manifest, its rendered files); and its `_headers` and
// `env.json` are rendered again from packages/web-host's profiles and must equal, byte for byte,
// the files in `--dir`. Any problem refuses the whole run, so no host is left on one release while
// another moved.
//
// The upload never uses CR-20, which lives only in the `staging-static` environment, nor the operator
// token: `pnpm fin` mints a one-run token with the operator token (CR-05), holding Workers Scripts
// Write on this account only and expiring within the hour, uses it for the uploads, and revokes it
// when the run ends, whether the uploads passed or failed or a signal stopped the run (the plan's
// cleanup, which the stop's trap runs too); a run closed at once before it could, or one whose
// revocation failed, says to revoke it by hand, and its run.done records that (`leftover`).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CloudflareCallError,
  cloudflareClient,
} from "../../../../tools/static-deploy/src/cloudflare.ts";
import { StaticConfigError } from "../../../../tools/static-deploy/src/config.ts";
import { own } from "../../../../tools/static-deploy/src/release.ts";
import {
  loadEnvironmentStatic,
  type PreparedDeployment,
  prepareStaticDeploy,
  stopSummary,
  uploadPrepared,
} from "../../../../tools/static-deploy/src/run.ts";
import type { WriteTarget } from "../cloudflare/api.ts";
import { cloudflare, railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import { flagBool, flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, DataError, ProviderError, RefusedError, UsageError } from "../core/errors.ts";
import type { Change } from "../core/plan.ts";
import { Secret } from "../core/secret.ts";
import { servicesOnRelease } from "../railway/running.ts";
import { newestRailwayDeployProblem } from "../railway/verify.ts";
import { checkMergeJob, verifiedManifest } from "../release/provenance.ts";
import { renderFor, requireRenderer } from "./render.ts";
import { loadWebHostRenderer, type RendererLoader } from "./renderer.ts";

const SHA = /^[0-9a-f]{40}$/;

function translate(error: unknown): unknown {
  if (error instanceof StaticConfigError) return new DataError(error.message);
  if (error instanceof CloudflareCallError)
    return new ProviderError("cloudflare", error.message, error.status);
  return error;
}

interface PermissionGroup {
  id: string;
  name: string;
}

interface ApiToken {
  id: string;
  name: string;
  value?: string;
}

/** The one-run token's body: one permission group, this account only, a short expiry. */
export function staticTokenBody(
  name: string,
  accountId: string,
  groupId: string,
  now: Date,
  minutes: number,
): Record<string, unknown> {
  const expires = new Date(now.getTime() + minutes * 60_000);
  return {
    name,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        permission_groups: [{ id: groupId }],
      },
    ],
    expires_on: `${expires.toISOString().slice(0, 19)}Z`,
  };
}

/** Checks that each rendered file equals a fresh render of this release (spec 01 §6.9 step 5). */
function checkAgainstRender(
  ctx: Context,
  prepared: readonly PreparedDeployment[],
  render: (key: string) => { headers: string; env: string },
): void {
  for (const item of prepared) {
    const fresh = render(item.key);
    const env = readFileSync(join(item.artefact.dir, "env.json"), "utf8");
    if (item.artefact.headers !== fresh.headers)
      throw new DataError(
        `static ${item.key}: the rendered _headers differs from a fresh render of this release; render again`,
      );
    if (env !== fresh.env)
      throw new DataError(
        `static ${item.key}: the rendered env.json differs from a fresh render of this release; render again`,
      );
  }
  ctx.out.info(`static: ${prepared.length} rendered _headers and env.json equal a fresh render`);
}

export function staticDeployCommand(load: RendererLoader = loadWebHostRenderer): Command {
  return {
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
      {
        name: "static-rollback",
        kind: "boolean",
        description:
          "put a release's pages back although the services do not run it (a rollback, pages first; recorded in the run)",
      },
      {
        name: "accept-unchecked-deployments",
        kind: "boolean",
        description:
          "upload although Railway did not say which image a service's newest deployment runs (checked by hand; recorded)",
      },
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
      for (const key of keys) {
        const s = own(ctx.settings.static, key);
        if (s === undefined) throw new UsageError(`no static deployment named ${key}`);
        ctx.guard.checkOwnName(s.script, "static deployment");
      }
      const renderer = await requireRenderer(load);
      checkMergeJob(ctx, release);
      const rollback = flagBool(ctx.args, "static-rollback");
      const ROLL_FIRST =
        "the services roll first, so a new page never meets an old API (spec 01 §6.9, S0-06); run railway deploy for this release, or pass --static-rollback to put an earlier release's pages back";
      const logged = rollback ? undefined : newestRailwayDeployProblem(ctx, release);
      if (logged !== undefined)
        throw new RefusedError(`this machine's run log ${logged}: ${ROLL_FIRST}`);
      const manifest = verifiedManifest(ctx, manifestFile, release);
      let deploymentsUnchecked = false;
      if (rollback) {
        ctx.out.warn(
          "uploading this release's pages without checking that the services run it, as a rollback (--static-rollback, recorded)",
        );
      } else {
        // What the services run now, read from Railway, with the manifest's digests now trusted.
        const { problems, unread } = await servicesOnRelease(ctx, railway(ctx), manifest);
        if (problems.length > 0)
          throw new RefusedError(
            `the services do not run this release now: ${problems.join("; ")}; ${ROLL_FIRST}`,
          );
        if (unread.length > 0) {
          if (!flagBool(ctx.args, "accept-unchecked-deployments"))
            throw new RefusedError(
              `Railway did not say which image the newest deployment of ${unread.join(", ")} runs; check in Railway that each runs this release's digest, then pass --accept-unchecked-deployments`,
            );
          deploymentsUnchecked = true;
          ctx.out.warn(
            `the image the newest deployment of ${unread.join(", ")} runs was not read; uploading on the operator's word (--accept-unchecked-deployments)`,
          );
        }
        ctx.out.info("static: every service runs this release now");
      }
      let prepared: PreparedDeployment[];
      try {
        prepared = prepareStaticDeploy({
          repoRoot: ctx.runtime.repoRoot,
          environment: loadEnvironmentStatic(ctx.runtime.repoRoot, ctx.environment),
          manifest,
          dir,
          ...(only === undefined ? {} : { only }),
        });
      } catch (error) {
        throw translate(error);
      }
      checkAgainstRender(ctx, prepared, (key) => renderFor(ctx, renderer, key, release));

      const t = ctx.settings.staticToken;
      ctx.guard.checkOwnName(t.name, "API token");
      const { api, writer, accountPath } = cloudflare(ctx);
      const groups = (
        await api.list<PermissionGroup>(`${accountPath}/tokens/permission_groups`)
      ).filter((g) => g.name === t.permissionGroup);
      if (groups.length !== 1 || groups[0] === undefined)
        throw new ConfigError(`no single permission group named ${t.permissionGroup}`);
      const groupId = groups[0].id;
      const target = (id?: string): WriteTarget => ({
        kind: "token",
        name: t.name,
        permissionGroups: [{ name: t.permissionGroup, id: groupId }],
        ...(id === undefined ? {} : { id }),
      });

      const changes: Change[] = [
        {
          kind: "token",
          name: t.name,
          action: "create",
          detail: `${t.permissionGroup}, this account only, ${t.expiryMinutes} minutes; revoked when the run ends`,
        },
        ...prepared.map(
          (p): Change => ({
            kind: "static",
            name: p.deployment.script,
            action: "update",
            detail: `release ${release.slice(0, 12)}, assets only, ${p.artefact.files.length} file(s)`,
          }),
        ),
      ];
      /** The one-run token's mint, from the moment it is sent. */
      let mint: Promise<ApiToken> | undefined;
      let token: Secret | undefined;
      /** The revocation: it runs once, on every way the run ends (the plan's cleanup). */
      let revocation: Promise<void> | undefined;
      /**
       * Whether no one-run token is left: revoked, or its mint answered none. Until then (the
       * revocation pending, or failed), a run closed at once says to revoke it by hand, and
       * run.done records it (the plan's leftover).
       */
      let tokenGone = false;
      const revokeByHand = `revoke it by hand now (it expires within ${t.expiryMinutes} minutes)`;
      const uploaded: string[] = [];
      const revoke = (): Promise<void> => {
        revocation ??= (async () => {
          if (mint === undefined) return;
          let id: string;
          try {
            // A mint still in flight when the run stops is waited for, so its token is revoked too.
            ({ id } = await mint);
          } catch {
            tokenGone = true;
            return;
          }
          try {
            await writer.write(target(id), "DELETE", `${accountPath}/tokens/${id}`);
          } catch (error) {
            ctx.out.error(`the one-run token ${t.name} could not be revoked: ${revokeByHand}`);
            throw error;
          }
          tokenGone = true;
          ctx.run.step("token", t.name, "revoke");
          ctx.out.info(`  revoked the one-run token ${t.name}`);
        })();
        return revocation;
      };
      return ctx.applyPlan(
        "static deploy",
        changes,
        async (change) => {
          if (change.kind === "token") {
            mint = writer.write<ApiToken>(
              target(),
              "POST",
              `${accountPath}/tokens`,
              staticTokenBody(
                t.name,
                ctx.overlay.cloudflare.accountId,
                groupId,
                ctx.runtime.now(),
                t.expiryMinutes,
              ),
            );
            const created = await mint;
            if (typeof created.value !== "string" || created.value === "")
              throw new ProviderError("cloudflare", "Cloudflare answered no token value", 0);
            ctx.masker.register(created.value, "<static-run-token>");
            token = new Secret(created.value);
            return;
          }
          const item = prepared.find((p) => p.deployment.script === change.name);
          if (item === undefined) return;
          try {
            if (token === undefined) throw new Error("no one-run token was minted");
            const result = await uploadPrepared(item, {
              client: cloudflareClient(token.reveal(), ctx.runtime.fetch),
              accountId: ctx.overlay.cloudflare.accountId,
              beforeWrite: (what) => ctx.run.assertWritable(what),
              log: (line) => ctx.out.info(line),
            });
            uploaded.push(item.key);
            ctx.run.line("deploy.static_step", "info", {
              deployment: change.name,
              deployedRelease: release,
              files: result.files,
              uploaded: result.uploaded,
              assetManifestHash: result.assetManifestHash,
            });
          } catch (error) {
            ctx.run.line("deploy.failed", "error", {
              step: `static ${item.key}`,
              deployedRelease: release,
            });
            ctx.out.error(
              stopSummary(
                item.key,
                uploaded,
                prepared.slice(prepared.indexOf(item) + 1).map((p) => p.key),
              ),
            );
            // The token is revoked by the plan's cleanup, before run.done.
            throw translate(error);
          }
        },
        {
          release,
          ...(rollback ? { staticRollback: true } : {}),
          ...(deploymentsUnchecked ? { deploymentsUnchecked: true } : {}),
        },
        {
          cleanup: revoke,
          leftover: () =>
            mint !== undefined && !tokenGone
              ? `the one-run token ${t.name} may not be revoked: ${revokeByHand}`
              : undefined,
          after: async () => {
            ctx.run.line("deploy.static_done", "info", {
              deployedRelease: release,
              deployments: uploaded.length,
            });
            return {};
          },
        },
      );
    },
  };
}

export const staticDeploy = staticDeployCommand();
