// Provenance (CI-05; spec 01 §6.9, `deploy-staging` step 2 and `deploy-static-staging` step 1;
// ARCHITECTURE §11.7): what release.yml built and attested for one release, checked with
// `gh attestation verify` before anything is deployed. The policy is pinned exactly:
//
//   - the certificate's SubjectAlternativeName is release.yml at refs/heads/main of this repository,
//     compared byte for byte (`--cert-identity`), so the owner's casing must be GitHub's own;
//   - the source commit is the release (`--source-digest`) and the source ref is main;
//   - the run was a `push` (read back from gh's JSON: gh has no flag for the trigger);
//   - no self-hosted runner signed it.
//
// gh's JSON is read back and every one of those is checked again, so a gh that ignored a flag cannot
// pass an attestation. A file is verified from a private copy, and the caller gets the bytes of that
// copy, so what was verified is exactly what is used. Node built-ins only: the caller passes the exec.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ReleaseIdentity {
  /** `<owner>/<repo>` as GitHub writes it (the owner's casing matters to the certificate). */
  repository: string;
  /** The workflow file inside the repository: `.github/workflows/release.yml`. */
  workflow: string;
  /** The ref the release is built from: `refs/heads/main`. */
  ref: string;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (program: string, args: readonly string[]) => ExecResult;

export class ProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProvenanceError";
  }
}

export const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const WORKFLOW = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
export const MAIN_REF = /^refs\/heads\/main$/;
const SHA = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates an identity read from a settings file. */
export function parseIdentity(raw: unknown, where: string): ReleaseIdentity {
  if (!isRecord(raw)) throw new ProvenanceError(`${where} must be an object`);
  const { repository, workflow, ref } = raw;
  if (typeof repository !== "string" || !REPOSITORY.test(repository))
    throw new ProvenanceError(`${where}.repository must be <owner>/<repo>`);
  if (typeof workflow !== "string" || !WORKFLOW.test(workflow))
    throw new ProvenanceError(`${where}.workflow must be .github/workflows/<file>.yml`);
  if (typeof ref !== "string" || !MAIN_REF.test(ref))
    throw new ProvenanceError(`${where}.ref must be refs/heads/main`);
  return { repository, workflow, ref };
}

/** The certificate identity release.yml signs with: the workflow at main of this repository. */
export function signerIdentity(id: ReleaseIdentity): string {
  return `https://github.com/${id.repository}/${id.workflow}@${id.ref}`;
}

/** The arguments of one `gh attestation verify` call. */
export function attestationArgs(subject: string, id: ReleaseIdentity, release: string): string[] {
  return [
    "attestation",
    "verify",
    subject,
    "--repo",
    id.repository,
    "--cert-identity",
    signerIdentity(id),
    "--source-ref",
    id.ref,
    "--source-digest",
    release,
    "--deny-self-hosted-runners",
    "--format",
    "json",
  ];
}

/**
 * Verifies one subject (`oci://<ref>` or a file path) against the release's identity. Throws a
 * ProvenanceError naming `what` (never a path or a digest) unless gh verifies it and at least one
 * verified attestation comes from a push to main of the pinned workflow, for this commit.
 */
export function verifyAttestation(
  exec: ExecFn,
  subject: string,
  id: ReleaseIdentity,
  release: string,
  what: string,
): void {
  if (!SHA.test(release)) throw new ProvenanceError("the release must be a full commit SHA");
  const result = exec("gh", attestationArgs(subject, id, release));
  if (result.status !== 0) {
    throw new ProvenanceError(
      `${what}: the attestation does not verify (built by ${id.workflow} on a push to ${id.ref} for this commit?)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new ProvenanceError(`${what}: gh attestation verify printed no JSON`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new ProvenanceError(`${what}: gh attestation verify verified no attestation`);
  const san = signerIdentity(id);
  const triggers = new Set<string>();
  for (const entry of parsed) {
    const certificate = isRecord(entry)
      ? (entry.verificationResult as { signature?: { certificate?: unknown } } | undefined)
          ?.signature?.certificate
      : undefined;
    if (!isRecord(certificate)) continue;
    triggers.add(String(certificate.buildTrigger ?? "unknown"));
    if (
      certificate.buildTrigger === "push" &&
      certificate.sourceRepositoryDigest === release &&
      certificate.sourceRepositoryRef === id.ref &&
      certificate.subjectAlternativeName === san
    ) {
      return;
    }
  }
  throw new ProvenanceError(
    `${what}: no verified attestation is from a push to ${id.ref} for this commit (triggers: ${[...triggers].join(", ") || "none"})`,
  );
}

/**
 * Verifies a file's attestation from a private copy and returns the copy's bytes, so the caller
 * uses exactly what was verified even if the original changes afterwards.
 */
export function verifyFileAttestation(
  exec: ExecFn,
  file: string,
  id: ReleaseIdentity,
  release: string,
  what: string,
): Buffer {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch {
    throw new ProvenanceError(`${what}: the file is missing or unreadable`);
  }
  const dir = mkdtempSync(join(tmpdir(), "fin-attest-"));
  try {
    const copy = join(dir, "subject");
    writeFileSync(copy, bytes, { mode: 0o600, flag: "wx" });
    verifyAttestation(exec, copy, id, release, what);
    return readFileSync(copy);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
