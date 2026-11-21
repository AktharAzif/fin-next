// The release manifest (`release-manifest.json`, ARCHITECTURE §11.7, written by release.yml): the
// commit, each image's digest, each static artefact's SHA-256 and asset manifest hash. Only the
// fields a deploy reads are validated here; anything malformed refuses the deploy.
//
// A deploy trusts the manifest only once its own attestation verifies (release.yml attests it as
// `release-<sha>`): loadVerifiedReleaseManifest checks it with the release's identity and parses the
// exact bytes it verified. There is no unverified loader. Lookups by a name that came from outside go
// through own(), so a key such as `constructor` is never mistaken for an entry.

import { StaticConfigError } from "./config.ts";
import {
  type ExecFn,
  ProvenanceError,
  type ReleaseIdentity,
  verifyFileAttestation,
} from "./provenance.ts";

export interface StaticEntry {
  artefact: string;
  sha256: string;
  assetManifestHash: string;
}

export interface ReleaseManifest {
  commit: string;
  images: Record<string, string>;
  static: Record<string, StaticEntry>;
  migrations: string[];
}

const SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseManifest(raw: unknown, release: string): ReleaseManifest {
  const problems: string[] = [];
  if (!SHA.test(release))
    throw new StaticConfigError("--release must be a full 40-character commit SHA");
  if (!isRecord(raw)) throw new StaticConfigError("the release manifest must be a JSON object");
  if (raw.commit !== release) problems.push("its commit is not --release");
  const images: Record<string, string> = {};
  const rawImages = raw.images ?? {};
  if (!isRecord(rawImages)) problems.push("images must be an object");
  else {
    for (const [name, digest] of Object.entries(rawImages)) {
      if (!/^fin-next-[a-z0-9-]+$/.test(name)) problems.push(`images.${name} is not a Fin image`);
      else if (typeof digest !== "string" || !DIGEST.test(digest))
        problems.push(`images.${name} is not a sha256 digest`);
      else images[name] = digest;
    }
  }
  const statics: Record<string, StaticEntry> = {};
  const rawStatic = raw.static ?? {};
  if (!isRecord(rawStatic)) problems.push("static must be an object");
  else {
    for (const [key, entry] of Object.entries(rawStatic)) {
      if (!isRecord(entry)) {
        problems.push(`static.${key} must be an object`);
        continue;
      }
      const artefact = entry.artefact;
      const sha256 = entry.sha256;
      const manifestHash = entry.assetManifestHash;
      if (typeof artefact !== "string" || !/^static-[a-z]+-[0-9a-f]{40}$/.test(artefact))
        problems.push(`static.${key}.artefact is malformed`);
      if (typeof sha256 !== "string" || !HEX64.test(sha256))
        problems.push(`static.${key}.sha256 is malformed`);
      if (typeof manifestHash !== "string" || !HEX64.test(manifestHash))
        problems.push(`static.${key}.assetManifestHash is malformed`);
      if (problems.length === 0) {
        statics[key] = {
          artefact: String(artefact),
          sha256: String(sha256),
          assetManifestHash: String(manifestHash),
        };
      }
    }
  }
  const migrations = raw.migrations ?? [];
  if (!Array.isArray(migrations) || migrations.some((m) => typeof m !== "string"))
    problems.push("migrations must be a list of names");
  if (problems.length > 0)
    throw new StaticConfigError(`the release manifest is invalid: ${problems.join("; ")}`);
  return { commit: release, images, static: statics, migrations: migrations as string[] };
}

/** An own entry of a record, or undefined (never an inherited member such as `constructor`). */
export function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Verifies the release manifest's attestation (release.yml, a push to main, this commit) and parses
 * the bytes that were verified. Anything else refuses the deploy before a change.
 */
export function loadVerifiedReleaseManifest(
  exec: ExecFn,
  file: string,
  identity: ReleaseIdentity,
  release: string,
): ReleaseManifest {
  let bytes: Buffer;
  try {
    bytes = verifyFileAttestation(exec, file, identity, release, "the release manifest");
  } catch (error) {
    if (error instanceof ProvenanceError) throw new StaticConfigError(error.message);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new StaticConfigError("the release manifest is not valid JSON");
  }
  return parseReleaseManifest(raw, release);
}
