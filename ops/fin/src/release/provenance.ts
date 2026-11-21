// What a deploy checks about a release before it changes anything (CI-05, BD-05; spec 01 §6.9,
// `deploy-staging` step 2 and `deploy-static-staging` step 1; ARCHITECTURE §11.7):
//
//   - ci.yml's `merge` job succeeded for the commit (spec 07 §2.3.4): the newest ci.yml run on a push
//     to main for exactly this commit has finished and its `merge` job concluded `success`; anything
//     else, a missing run or job included, refuses the deploy;
//   - the release manifest's own attestation verifies, so its digests and hashes are release.yml's;
//   - each image and each static artefact's attestation verifies with the same pinned identity.
//
// The attestation calls are tools/static-deploy's (provenance.ts), shared with the CI entry point.

import { StaticConfigError } from "../../../../tools/static-deploy/src/config.ts";
import {
  ProvenanceError,
  type ReleaseIdentity,
  verifyAttestation,
  verifyFileAttestation,
} from "../../../../tools/static-deploy/src/provenance.ts";
import {
  loadVerifiedReleaseManifest,
  type ReleaseManifest,
} from "../../../../tools/static-deploy/src/release.ts";
import type { Context } from "../core/context.ts";
import { DataError, ProviderError, RefusedError } from "../core/errors.ts";

export function releaseIdentity(ctx: Context): ReleaseIdentity {
  const r = ctx.settings.release;
  return { repository: r.repository, workflow: r.workflow, ref: r.ref };
}

/** The release manifest, once its attestation verified (exit 65 otherwise). */
export function verifiedManifest(ctx: Context, file: string, release: string): ReleaseManifest {
  try {
    const manifest = loadVerifiedReleaseManifest(
      (program, args) => ctx.runtime.exec(program, args),
      file,
      releaseIdentity(ctx),
      release,
    );
    ctx.out.info(
      "release manifest: attestation verified (release.yml, a push to main, this commit)",
    );
    return manifest;
  } catch (error) {
    if (error instanceof StaticConfigError) throw new DataError(error.message);
    throw error;
  }
}

/** Verifies one image's attestation (`oci://<ref>`) for this release. */
export function verifyImage(ctx: Context, ref: string, release: string): void {
  try {
    verifyAttestation(
      (program, args) => ctx.runtime.exec(program, args),
      `oci://${ref}`,
      releaseIdentity(ctx),
      release,
      `the image ${ref.split("@")[0]?.split("/").at(-1) ?? "image"}`,
    );
  } catch (error) {
    if (error instanceof ProvenanceError) throw new DataError(error.message);
    throw error;
  }
}

/** Verifies a downloaded artefact archive's attestation and returns the verified bytes. */
export function verifyArchive(ctx: Context, file: string, release: string, what: string): Buffer {
  try {
    return verifyFileAttestation(
      (program, args) => ctx.runtime.exec(program, args),
      file,
      releaseIdentity(ctx),
      release,
      what,
    );
  } catch (error) {
    if (error instanceof ProvenanceError) throw new DataError(error.message);
    throw error;
  }
}

function ghJson(ctx: Context, path: string): unknown {
  const result = ctx.runtime.exec("gh", ["api", "-H", "Accept: application/vnd.github+json", path]);
  if (result.status !== 0) {
    throw new ProviderError(
      "github",
      `gh api ${path.split("?")[0]} failed (is gh signed in to GitHub?)`,
      0,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ProviderError("github", `gh api ${path.split("?")[0]} printed no JSON`, 0);
  }
}

interface WorkflowRun {
  id?: number;
  head_sha?: string;
  head_branch?: string;
  event?: string;
  path?: string;
  status?: string;
  conclusion?: string | null;
}

interface Job {
  name?: string;
  status?: string;
  conclusion?: string | null;
  head_sha?: string;
}

/**
 * Refuses unless ci.yml's `merge` job succeeded for exactly this commit on a push to main (spec 01
 * §6.9 step 2; spec 07 §2.3.4; BD-05). The two jobs are in different workflows, so this reads the
 * newest such run of ci.yml and its jobs through the GitHub API.
 */
export function checkMergeJob(ctx: Context, release: string): void {
  const r = ctx.settings.release;
  const file = r.mergeCheck.workflow.split("/").at(-1) ?? "";
  const runs = ghJson(
    ctx,
    `repos/${r.repository}/actions/workflows/${file}/runs?head_sha=${release}&event=push&branch=main&per_page=20`,
  ) as { workflow_runs?: WorkflowRun[] };
  const matching = (runs.workflow_runs ?? []).filter(
    (run) =>
      run.head_sha === release &&
      run.event === "push" &&
      run.head_branch === "main" &&
      run.path === r.mergeCheck.workflow &&
      typeof run.id === "number",
  );
  const run = matching[0];
  const what = `${file}'s ${r.mergeCheck.job} job`;
  if (run === undefined) {
    throw new RefusedError(
      `${what}: no ${file} run on a push to main for this commit; the deploy needs its success (spec 01 §6.9 step 2)`,
    );
  }
  if (run.status !== "completed") {
    throw new RefusedError(`${what}: the ${file} run for this commit has not finished`);
  }
  const jobs = ghJson(
    ctx,
    `repos/${r.repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
  ) as { jobs?: Job[] };
  const job = (jobs.jobs ?? []).filter((j) => j.name === r.mergeCheck.job);
  if (job.length !== 1 || job[0] === undefined) {
    throw new RefusedError(
      `${what}: the ${file} run for this commit has ${job.length === 0 ? "no" : "more than one"} ${r.mergeCheck.job} job; the deploy needs its success`,
    );
  }
  if (job[0].head_sha !== undefined && job[0].head_sha !== release) {
    throw new RefusedError(`${what}: the job ran for another commit`);
  }
  if (job[0].conclusion !== "success") {
    throw new RefusedError(
      `${what} concluded ${job[0].conclusion ?? job[0].status ?? "nothing"} for this commit, not success`,
    );
  }
  ctx.out.info(`${what}: success for this commit`);
}
