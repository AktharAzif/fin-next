# Runbook: `pnpm fin static render`, `pnpm fin static deploy` and `tools/static-deploy`

The browser apps are served by assets-only Workers static assets deployments with no script
([FD-17]; spec 01 §7.4). Builds are environment-neutral; the deploy renders each build's `_headers`
and `env.json`, then uploads it through Cloudflare's API with Node built-ins only (BD-16: no
`wrangler`, so no install script), always after the Railway services have rolled (§6.9).

## 1. Render

```sh
node ops/fin/src/main.ts static render staging --release <sha> --artefacts <builds> --out <rendered>
```

- `<builds>/<key>/` is each deployment's attested build: `verify`, `selfie`, `admin`, `console`,
  `docs` (verify's app builds both `verify` and `selfie`).
- A build that already holds `_headers`, `env.json` or a source map is refused (exit 65).
- The renderer is packages/web-host's (`packages/web-host/src/static/render.ts`, P0-D); until it
  exists the command refuses (exit 78): there is no fallback renderer.
- The result is checked before anything is written: it names only this environment's hosts, no
  public output names Fin Admin's host, and `env.json` carries this release and environment.
- `<rendered>` must be new or empty; each `<rendered>/<key>/` is a copy of the build with the two
  rendered files.

## 2. Upload

On the operator machine (BD-05), inside a registered run:

```sh
export FIN_CF_STATIC_TOKEN_FILE=<static deploy token file>
node ops/fin/src/main.ts static deploy staging --release <sha> --manifest release-manifest.json --dir <rendered> --dry-run
node ops/fin/src/main.ts static deploy staging --release <sha> --manifest release-manifest.json --dir <rendered>
```

From a CI job that holds the static deploy token alone (`staging-static`, CR-20):

```sh
node tools/static-deploy/src/main.ts --env staging --release <sha> --manifest release-manifest.json --dir <rendered>
```

For each deployment, in the order verify, selfie, admin, console, docs:

1. its `apps/<app>/static.json` must hold only the allowlisted keys (no `main`, module, binding,
   `run_worker_first`, route, cron or domain);
2. the build's files (the rendered `_headers` and `env.json` left out) must hash to the release
   manifest's `assetManifestHash`;
3. an upload session with every file's path, size and hash; only the files Cloudflare lacks are sent,
   with the session's own upload token;
4. one script upload whose only part is `metadata` (`compatibility_date` and
   `assets: {jwt, config: {not_found_handling, html_handling, _headers}}`);
5. `workers.dev` and previews off;
6. the re-read: no module, no handler, no binding, assets present, `workers.dev` and previews off.

A failure stops the run; the hosts not yet uploaded keep the previous release, and the output says
which. `deploy.static_step` per deployment and `deploy.static_done` are written as lines.

The first upload comes before `pnpm fin routes apply` (the routes need the deployments to exist).

## Check it

- `curl -sI https://<console host>/` shows the rendered headers; a deep link answers the app; one
  `/assets/` file answers `public, max-age=31536000, immutable`.
- The watcher's `static` check stays green (`static-deployment-changed.md`).

## Roll back

Render and upload the previous release's attested builds the same way; the previous release's
`/assets/` are carried in every build (FW-C13), so open tabs keep working.
