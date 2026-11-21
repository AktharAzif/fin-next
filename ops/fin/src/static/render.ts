// `pnpm fin static render <env> --release <sha> --manifest <file> --archives <dir> --out <dir>`
// (spec 01 §6.9, `deploy-static-staging` steps 1 and 2, §7.4; SF-05; EX-29). Before anything is
// written:
//
//   1. the release manifest's attestation verifies (release.yml, a push to main, this commit);
//   2. for each static deployment, the downloaded artefact archive (`<archives>/static-<key>-<sha>.zip`,
//      the zip GitHub keeps for the artifact) has the SHA-256 the manifest records and its own
//      attestation verifies; it is unpacked in memory from the verified bytes, and the files must
//      hash to the manifest's `assetManifestHash`;
//   3. builds are environment-neutral, so an archive that holds `_headers`, `env.json` or a source map
//      is refused;
//   4. `_headers` and `env.json` are rendered from packages/web-host's profiles and the environment's
//      hostnames, and checked: they name only this environment's hosts, no public output names Fin
//      Admin's host, and `env.json` carries this release and environment.
//
// Then `<out>/<key>/` gets the archive's files and the two rendered files, which `pnpm fin static
// deploy` uploads after rendering them again and comparing.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type AssetFile,
  assetHash,
  assetManifestHash,
  contentTypeOf,
} from "../../../../tools/static-deploy/src/artefact.ts";
import { sha256Hex } from "../../../../tools/static-deploy/src/provenance.ts";
import { own } from "../../../../tools/static-deploy/src/release.ts";
import type { Command } from "../command.ts";
import { flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, DataError, RefusedError, UsageError } from "../core/errors.ts";
import { HOST_ROLES, type HostRole } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import { verifiedManifest, verifyArchive } from "../release/provenance.ts";
import {
  loadWebHostRenderer,
  type RendererLoader,
  type RenderOutput,
  type StaticRenderer,
} from "./renderer.ts";
import { readZip, ZipError, type ZipFile } from "./zip.ts";

const SHA = /^[0-9a-f]{40}$/;
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

/** The files a build must not hold: the deploy renders them (SF-05), and maps never ship. */
export function refuseRenderedFiles(files: readonly ZipFile[]): void {
  for (const { path } of files) {
    if (path === "_headers" || path === "env.json") {
      throw new DataError(
        `the build holds /${path}; builds are environment-neutral and the deploy renders it`,
      );
    }
    if (path.endsWith(".map")) throw new DataError(`the build holds a source map (/${path})`);
  }
}

/** The asset manifest hash of a build's files, as release.yml and the upload compute it. */
export function buildHash(files: readonly ZipFile[]): string {
  const assets: AssetFile[] = files.map(({ path, data }) => ({
    path: `/${path}`,
    abs: "",
    size: data.length,
    hash: assetHash(data, `/${path}`),
    contentType: contentTypeOf(path),
  }));
  return assetManifestHash(assets);
}

/** The hosts an output may name: every host of the environment, Fin Admin's only in its own. */
export function hostsFor(ctx: Context, key: string): Partial<Record<HostRole, string>> {
  const hosts: Partial<Record<HostRole, string>> = {};
  for (const role of HOST_ROLES) {
    if (role === "pg" || (role === "admin" && key !== "admin")) continue;
    const host = ctx.overlay.hosts[role];
    if (host !== undefined) hosts[role] = host;
  }
  return hosts;
}

/** Checks a rendered output against the deploy's hostnames. */
export function checkRendered(ctx: Context, key: string, release: string, out: RenderOutput): void {
  if (typeof out.headers !== "string" || out.headers.trim() === "")
    throw new DataError(`${key}: the renderer gave no _headers`);
  if (out.headers.split("\n").some((line) => line.length > 2000))
    throw new DataError(`${key}: a _headers line is over 2,000 characters`);
  const env = JSON.stringify(out.env);
  if (out.env.release !== release)
    throw new DataError(`${key}: env.json does not carry this release`);
  if (out.env.environment !== ctx.environment)
    throw new DataError(`${key}: env.json does not carry this environment`);
  const allowed = new Set(Object.values(hostsFor(ctx, key)).map((h) => h.toLowerCase()));
  const zone = ctx.overlay.zone.toLowerCase();
  for (const text of [out.headers, env]) {
    for (const match of text.matchAll(HOSTNAME)) {
      const host = match[0].toLowerCase();
      if (host !== zone && !host.endsWith(`.${zone}`)) continue;
      if (!allowed.has(host)) {
        throw new RefusedError(
          `${key}: the rendered files name ${host}, which this output may not name`,
        );
      }
    }
  }
  const admin = ctx.overlay.hosts.admin?.toLowerCase();
  if (
    key !== "admin" &&
    admin !== undefined &&
    `${out.headers}${env}`.toLowerCase().includes(admin)
  ) {
    throw new RefusedError(`${key}: a public output names Fin Admin's host`);
  }
}

/** The bytes of the two rendered files, exactly as render writes them and deploy compares them. */
export function renderedContents(out: RenderOutput): { headers: string; env: string } {
  return {
    headers: out.headers.endsWith("\n") ? out.headers : `${out.headers}\n`,
    env: `${JSON.stringify(out.env)}\n`,
  };
}

/** Renders and checks one deployment's two files. */
export function renderFor(
  ctx: Context,
  renderer: StaticRenderer,
  key: string,
  release: string,
): { headers: string; env: string } {
  const s = own(ctx.settings.static, key);
  if (s === undefined) throw new UsageError(`no static deployment named ${key}`);
  const output = renderer.renderStatic({
    output: key,
    app: s.app,
    profile: s.profile,
    environment: ctx.environment,
    release,
    hosts: hostsFor(ctx, key),
    indexable: false,
  });
  checkRendered(ctx, key, release, output);
  return renderedContents(output);
}

/** Loads the renderer, or refuses while packages/web-host's renderer does not exist. */
export async function requireRenderer(load: RendererLoader): Promise<StaticRenderer> {
  const renderer = await load();
  if (renderer === undefined) {
    throw new ConfigError(
      "static render waits for packages/web-host/src/static/render.ts (P0-D's web-host pull request); there is no fallback renderer",
    );
  }
  return renderer;
}

interface Rendered {
  files: ZipFile[];
  headers: string;
  env: string;
}

export function staticRenderCommand(load: RendererLoader = loadWebHostRenderer): Command {
  return {
    words: ["static", "render"],
    summary:
      "verify each attested static artefact and render its _headers and env.json from packages/web-host's profiles",
    positionals: [],
    flags: [
      { name: "release", kind: "string", description: "the release's full commit SHA" },
      {
        name: "manifest",
        kind: "string",
        description: "the release manifest (release-manifest.json, artefact release-<sha>)",
      },
      {
        name: "archives",
        kind: "string",
        description: "the downloaded artefact archives: <dir>/static-<key>-<sha>.zip",
      },
      {
        name: "out",
        kind: "string",
        description: "where the rendered copies go (must not exist yet)",
      },
      { name: "only", kind: "string", description: "render one deployment only" },
    ],
    overlay: true,
    mutating: true,
    runbook: "static-deploy.md",
    async run(ctx) {
      const release = flagString(ctx.args, "release") ?? "";
      const manifestFile = flagString(ctx.args, "manifest");
      const archives = flagString(ctx.args, "archives");
      const outDir = flagString(ctx.args, "out");
      if (!SHA.test(release))
        throw new UsageError("--release must be the full 40-character commit SHA");
      if (manifestFile === undefined || archives === undefined || outDir === undefined)
        throw new UsageError("--manifest, --archives and --out are required");
      const only = flagString(ctx.args, "only");
      const keys = only === undefined ? ctx.settings.staticOrder : [only];
      for (const key of keys) {
        if (own(ctx.settings.static, key) === undefined)
          throw new UsageError(`no static deployment named ${key}`);
      }
      const renderer = await requireRenderer(load);
      if (existsSync(outDir) && readdirSync(outDir).length > 0)
        throw new UsageError("--out must be a new or empty directory");
      const manifest = verifiedManifest(ctx, manifestFile, release);

      const rendered = new Map<string, Rendered>();
      const changes: Change[] = [];
      for (const key of keys) {
        const entry = own(manifest.static, key);
        if (entry === undefined) throw new DataError(`the release manifest has no static.${key}`);
        if (entry.artefact !== `static-${key}-${release}`)
          throw new DataError(`static ${key}: the manifest names another artefact`);
        const bytes = verifyArchive(
          ctx,
          join(archives, `${entry.artefact}.zip`),
          release,
          `static ${key}`,
        );
        if (sha256Hex(bytes) !== entry.sha256)
          throw new DataError(`static ${key}: the archive's SHA-256 is not the release manifest's`);
        let files: ZipFile[];
        try {
          files = readZip(bytes);
        } catch (error) {
          if (error instanceof ZipError) throw new DataError(`static ${key}: ${error.message}`);
          throw error;
        }
        refuseRenderedFiles(files);
        if (buildHash(files) !== entry.assetManifestHash) {
          throw new DataError(
            `static ${key}: the archive's files do not hash to the release manifest's assetManifestHash`,
          );
        }
        rendered.set(key, { files, ...renderFor(ctx, renderer, key, release) });
        changes.push({
          kind: "render",
          name: key,
          action: "create",
          detail: `${files.length} file(s), attested; ${own(ctx.settings.static, key)?.profile} profile`,
        });
      }
      ctx.out.info(`static: ${rendered.size} archive(s) verified against the release manifest`);
      return ctx.applyPlan(
        "static render",
        changes,
        async (change) => {
          const output = rendered.get(change.name);
          if (output === undefined) return;
          const target = join(outDir, change.name);
          mkdirSync(target, { recursive: true });
          for (const file of output.files) {
            const path = join(target, ...file.path.split("/"));
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, file.data, { flag: "wx" });
          }
          writeFileSync(join(target, "_headers"), output.headers, { flag: "wx" });
          writeFileSync(join(target, "env.json"), output.env, { flag: "wx" });
        },
        { release },
      );
    },
  };
}

export const staticRender = staticRenderCommand();
