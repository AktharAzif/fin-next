// The static upload for a CI job that holds the static deploy token alone (CR-20 in the
// `staging-static` environment, [FD-19], BD-16):
//
//   node tools/static-deploy/src/main.ts --env staging --release <sha> --manifest <file> --dir <rendered>
//
// Before the token is read, the release manifest's attestation is verified with `gh attestation
// verify` (release.yml, a push to main, this commit) and every deployment is checked: its
// static.json, its build's hash against that manifest, and its rendered `_headers` and `env.json`.
// The token is read from the file FIN_CF_STATIC_TOKEN_FILE names. The account is the one account
// the token can see (CR-20 is scoped to one), so the job needs no overlay; its ID is masked in
// Actions before anything prints. The operator machine runs the same code through
// `pnpm fin static deploy`, inside a registered run, with a one-run token instead of CR-20.

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflareClient, type FetchFn } from "./cloudflare.ts";
import { StaticConfigError } from "./config.ts";
import type { ExecFn } from "./provenance.ts";
import { loadVerifiedReleaseManifest } from "./release.ts";
import { loadEnvironmentStatic, prepareStaticDeploy, uploadAll } from "./run.ts";

export interface MainIo {
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  repoRoot: string;
  fetch: FetchFn;
  /** Runs a program with arguments and no shell (`gh attestation verify`). */
  exec: ExecFn;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const FLAGS = new Set(["env", "release", "manifest", "dir", "only"]);

function parse(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i]?.replace(/^--/, "") ?? "";
    const value = argv[i + 1];
    if (!argv[i]?.startsWith("--") || !FLAGS.has(name))
      throw new StaticConfigError(`unknown argument ${argv[i]}`);
    if (value === undefined || value.startsWith("--"))
      throw new StaticConfigError(`--${name} needs a value`);
    if (flags.has(name)) throw new StaticConfigError(`--${name} is given twice`);
    flags.set(name, value);
  }
  for (const name of ["env", "release", "manifest", "dir"]) {
    if (!flags.has(name)) throw new StaticConfigError(`--${name} is required`);
  }
  if (!["staging"].includes(flags.get("env") ?? ""))
    throw new StaticConfigError("--env must be staging");
  return flags;
}

function readToken(env: MainIo["env"]): string {
  const path = env.FIN_CF_STATIC_TOKEN_FILE;
  if (path === undefined || path === "")
    throw new StaticConfigError("FIN_CF_STATIC_TOKEN_FILE is not set");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new StaticConfigError("FIN_CF_STATIC_TOKEN_FILE names a file that does not exist");
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
    throw new StaticConfigError(
      "FIN_CF_STATIC_TOKEN_FILE must name a regular file readable by its owner only",
    );
  }
  const token = readFileSync(path, "utf8").replace(/\r?\n$/, "");
  if (token === "" || /\s/.test(token))
    throw new StaticConfigError("FIN_CF_STATIC_TOKEN_FILE holds no single value");
  return token;
}

export async function main(io: MainIo): Promise<number> {
  let token = "";
  let accountId = "";
  const mask = (text: string) => {
    let out = text;
    for (const value of [token, accountId])
      if (value.length >= 8) out = out.split(value).join("<masked>");
    return out;
  };
  const log = (line: string) => io.stdout(`${mask(line)}\n`);
  try {
    const flags = parse(io.argv);
    const release = flags.get("release") ?? "";
    const environment = loadEnvironmentStatic(io.repoRoot, flags.get("env") ?? "");
    const manifest = loadVerifiedReleaseManifest(
      io.exec,
      flags.get("manifest") ?? "",
      environment.identity,
      release,
    );
    log("release manifest: attestation verified (release.yml, a push to main, this commit)");
    const prepared = prepareStaticDeploy({
      repoRoot: io.repoRoot,
      environment,
      manifest,
      dir: flags.get("dir") ?? "",
      ...(flags.has("only") ? { only: flags.get("only") ?? "" } : {}),
    });
    log(`static: ${prepared.length} deployment(s) checked against the release manifest`);
    token = readToken(io.env);
    if (io.env.GITHUB_ACTIONS === "true") io.stdout(`::add-mask::${token}\n`);
    const client = cloudflareClient(token, io.fetch);
    const accounts = await client.get<Array<{ id: string }>>("/accounts");
    if (accounts.length !== 1 || accounts[0] === undefined) {
      throw new StaticConfigError(
        `the token sees ${accounts.length} accounts; the static deploy token is scoped to one`,
      );
    }
    accountId = accounts[0].id;
    if (io.env.GITHUB_ACTIONS === "true") io.stdout(`::add-mask::${accountId}\n`);
    const results = await uploadAll(prepared, {
      client,
      accountId,
      beforeWrite: () => {},
      log,
    });
    for (const r of results) {
      log(
        JSON.stringify({
          event: "deploy.static_step",
          deployment: r.name,
          deployedRelease: release,
          files: r.files,
          uploaded: r.uploaded,
          assetManifestHash: r.assetManifestHash,
        }),
      );
    }
    log(
      JSON.stringify({
        event: "deploy.static_done",
        deployedRelease: release,
        deployments: results.length,
      }),
    );
    return 0;
  } catch (error) {
    io.stderr(`error: ${mask(error instanceof Error ? error.message : "failed")}\n`);
    return error instanceof StaticConfigError ? 65 : 69;
  }
}

if (import.meta.main) {
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    repoRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    fetch: (url, init) => fetch(url, init),
    exec: (program, args) => {
      try {
        const stdout = execFileSync(program, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        });
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const e = error as { status?: number | null; stdout?: string; stderr?: string };
        return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    stdout: (t) => {
      process.stdout.write(t);
    },
    stderr: (t) => {
      process.stderr.write(t);
    },
  });
}
