// `pnpm fin static render <env> --release <sha> --artefacts <dir> --out <dir>` (spec 01 §6.9 step 2,
// §7.4; SF-05; EX-29): copies each attested static build and renders its `_headers` and `env.json`
// into the copy, from packages/web-host's profiles and the environment's hostnames. Builds are
// environment-neutral, so an artefact that already holds `_headers`, `env.json` or a source map is
// refused. The result is checked before it is written: it names only this environment's hosts, no
// public output names Fin Admin's host, and `env.json` carries this release and environment.
//
// `<artefacts>/<key>/` is the build of each static deployment (console, admin, verify, selfie,
// docs); the rendered copy goes to `<out>/<key>/`, which `pnpm fin static deploy` then uploads.

import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Command } from "../command.ts";
import { flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, DataError, RefusedError, UsageError } from "../core/errors.ts";
import { HOST_ROLES, type HostRole } from "../core/overlay.ts";
import type { Change } from "../core/plan.ts";
import { loadWebHostRenderer, type RendererLoader, type RenderOutput } from "./renderer.ts";

const SHA = /^[0-9a-f]{40}$/;
const HOSTNAME = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\b/gi;

/** The files a build must not hold: the deploy renders them (SF-05), and maps never ship. */
export function refuseRenderedFiles(dir: string): void {
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const path = `/${relative(dir, abs)}`;
      if (lstatSync(abs).isSymbolicLink())
        throw new DataError(`${path} is a link; a build holds files only`);
      if (entry.isDirectory()) walk(abs);
      else if (path === "/_headers" || path === "/env.json") {
        throw new DataError(
          `the build holds ${path}; builds are environment-neutral and the deploy renders it`,
        );
      } else if (path.endsWith(".map"))
        throw new DataError(`the build holds a source map (${path})`);
    }
  };
  walk(dir);
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

export function staticRenderCommand(load: RendererLoader = loadWebHostRenderer): Command {
  return {
    words: ["static", "render"],
    summary: "render each static build's _headers and env.json from packages/web-host's profiles",
    positionals: [],
    flags: [
      { name: "release", kind: "string", description: "the release's full commit SHA" },
      {
        name: "artefacts",
        kind: "string",
        description: "the builds: one directory per deployment",
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
      const artefacts = flagString(ctx.args, "artefacts");
      const outDir = flagString(ctx.args, "out");
      if (!SHA.test(release))
        throw new UsageError("--release must be the full 40-character commit SHA");
      if (artefacts === undefined || outDir === undefined)
        throw new UsageError("--artefacts and --out are required");
      const only = flagString(ctx.args, "only");
      const keys = only === undefined ? ctx.settings.staticOrder : [only];
      const renderer = await load();
      if (renderer === undefined) {
        throw new ConfigError(
          "static render waits for packages/web-host/src/static/render.ts (P0-D's web-host pull request); there is no fallback renderer",
        );
      }
      if (existsSync(outDir) && readdirSync(outDir).length > 0)
        throw new UsageError("--out must be a new or empty directory");

      const rendered = new Map<string, RenderOutput>();
      const changes: Change[] = [];
      for (const key of keys) {
        const s = ctx.settings.static[key];
        if (s === undefined) throw new UsageError(`no static deployment named ${key}`);
        const input = join(artefacts, key);
        if (!existsSync(input) || !lstatSync(input).isDirectory())
          throw new DataError(`${key}: no build at <artefacts>/${key}`);
        refuseRenderedFiles(input);
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
        rendered.set(key, output);
        changes.push({
          kind: "render",
          name: key,
          action: "create",
          detail: `${s.profile} profile, ${s.app} build`,
        });
      }
      return ctx.applyPlan(
        "static render",
        changes,
        async (change) => {
          const output = rendered.get(change.name);
          if (output === undefined) return;
          const target = join(outDir, change.name);
          mkdirSync(outDir, { recursive: true });
          cpSync(join(artefacts, change.name), target, {
            recursive: true,
            errorOnExist: true,
            force: false,
            verbatimSymlinks: true,
          });
          writeFileSync(
            join(target, "_headers"),
            output.headers.endsWith("\n") ? output.headers : `${output.headers}\n`,
          );
          writeFileSync(join(target, "env.json"), `${JSON.stringify(output.env)}\n`);
        },
        { release },
      );
    },
  };
}

export const staticRender = staticRenderCommand();
