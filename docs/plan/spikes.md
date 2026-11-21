# fin-next: the spike log

Part of the fin-next plan (R13). It records every spike run: which spike, when it ran on the build
clock, its result, what it showed and what it changed. A new finding from a run is numbered `NF-n`
and listed among the run's follow-ups. The spikes and their pass rules are in
[ARCHITECTURE](ARCHITECTURE.md) §11.11 and [EXECUTION](EXECUTION.md) §2.6, and
[spec 01](specs/01-phase0-platform.md) §11.3 says how a row is written. The build adds rows through
its pull requests ([BD-06]), in public-safe words only ([G-09]): never a zone name, an ID, an
address, a token, a local path or a time zone. Hosts are written with the staging names [FD-09]
gives each role on `<staging-zone>`, such as `staff.<staging-zone>` for Fin Admin and
`gateway.<staging-zone>` for the API.

| Run | Spike | When (build clock) | Result | What it showed | Follow-ups |
|---|---|---|---|---|---|
| 1 | S-01 (SP-25) Same-host routing ([FD-18]; EXECUTION §2.6; spec 01 §11.2) | Sat 21 Nov, 09:10 to 09:25 | `pass` | The shape stays: one host per app, a Workers route sending `/*` to the assets-only deployment, and a route with no Worker letting `/api/*` fall through to the tunnel. Set-up: a throwaway, locally managed tunnel with a rendered ingress map; its connector `cloudflared` 2026.11.1, run on the operator machine and not on Railway, with its checksum and Cloudflare Developer ID signature checked; hosts `c1-spike.<staging-zone>` and, behind a throwaway Access application, `c1-spike-admin.<staging-zone>`; a throwaway assets-only deployment, uploaded through Cloudflare's API. (a), (b): `/` and `/settings/team` gave the static response, with the test `_headers`. (c), (d): `/api/` paths got the tunnel's answer, 418. (e), in a real browser: a same-origin JSON POST got the tunnel's 418, response type `basic`, with no redirect and no preflight. (f): navigating to `/api/ping` gave the tunnel's answer, not the single-page app. (g): the edge normalises `/x/../api/ping` and `//api/ping` for route matching, so they go to the tunnel, but the raw path is forwarded and `cloudflared`'s catch-all answers 404: safe, but the edge and the tunnel disagree; `/api%2Fping` goes to static, with a 307 to `/api/ping`; so (g) needed its fallback rule. (h): no Worker invocations were recorded. (i): on the admin spike host, `/`, a hashed asset, `/api/` and `/api/ping` all redirected to Access, and the `workers.dev` copy answered error 1042. (j): `/api/../settings`, `/API/ping`, `/api` and `/apix` all went to static. (k): not run yet; the static test server does not exist yet. NF-1: with `not_found_handling: single-page-application`, any missing `/assets/*` path returns `index.html` with 200, and the immutable `Cache-Control` that `_headers` gives `/assets/*` applies to it, whatever `Sec-Fetch-Mode` and `Sec-Fetch-Dest` say, so a deploy-skew race would cache HTML under a chunk URL for a year. NF-2: a `*.map` path gets the single-page app (200), not the 404 that AC-P0-23 then asked for; harmless, since builds strip maps. Everything was torn down at 09:25, and the zone was read back holding only the old product's records | [BD-10] (the connector on the operator machine; S-04 moves it to the real connector services); [BD-11] (zone rules written through the per-rule endpoints, with `fin_next_` refs); [BD-12] (NF-1: `no-store` on HTML under `/assets/`); [BD-13] ((g)'s fallback rule, which also refuses `*.map`); NF-1; NF-2 |

**SP-26's data points from run 1** (spec 01 §15 item 4; DECISIONS appendix C, SF-02). Cloudflare's
API alone can make an assets-only deployment: the upload metadata carries only `compatibility_date`
and `assets` (`jwt`, plus `config` with `not_found_handling`, `html_handling` and `_headers`), with
no module part, and the result reports `has_assets: true` and `has_modules: false`. [BD-16]'s API
upload from `tools/static-deploy` rests on this point. `! Cache-Control` detaches a header, so a
hashed asset carries exactly one `public, max-age=31536000, immutable`. The script's subdomain
endpoint turns `workers.dev` and previews off. SP-26 itself stays open: the served headers for `/`,
a deep link and an asset under a rendered profile, a redeploy keeping the previous release's
assets, and a read-back showing no binding have not run. They run before the first staging deploy.

**Railway sealed variables** (21 Nov, about 09:58; tested by the build). Railway seals a variable
through its API, with `environmentPatchCommit` and
`{services: {<id>: {variables: {NAME: {value, isSealed: true}}}}}`. `pnpm fin` sets every staging
secret this way, so spec 01 §6.7's "sealed" holds.
