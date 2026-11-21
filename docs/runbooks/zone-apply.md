# Runbook: `pnpm fin zone apply <env>`

Applies the zone settings and Fin's zone rules (spec 01 §7.6; ARCHITECTURE §5.6 to §5.8, §5.11;
BD-11, BD-12, BD-13). Read `pnpm-fin.md` first (the overlay, credentials, plans, the guard).

## What it writes

| Phase | Ref | Matches | Does |
|---|---|---|---|
| request header transform | `fin_next_ingress_proof_api` | the API host | sets `Fin-Ingress-Proof` |
| request header transform | `fin_next_ingress_proof_<role>` | console, admin, verify, selfie on `/api/` | sets that host's `Fin-Ingress-Proof` |
| single redirect | `fin_next_https_browser_hosts` | plain http GET and HEAD on the browser hosts | 308 to https, query kept |
| WAF custom | `fin_next_http_unsafe_block` | any other method over plain http on the browser hosts | block |
| WAF custom | `fin_next_path_refuse` (BD-13) | `..`, `//`, `%2E`, `%2F`, `\`, `%5C`, `;` or a `.map` ending in the raw path of a browser host (case-insensitive for the encoded forms) | block |
| configuration | `fin_next_api_no_challenge` | the API host, and `/api/` on the app hosts | Browser Integrity Check off, Security Level essentially off |
| cache | `fin_next_api_bypass_cache` | the same | bypass the cache |
| response header transform | `fin_next_assets_html_no_store` (BD-12) | an `/assets/` path on a browser host answered with `text/html` | `Cache-Control: no-store` |
| rate limit (optional) | `fin_next_api_v4_rate` | `/v4/` on the API host, per address, 10 s | block 10 s; threshold `thresholds.api-v4` from the overlay. **Not written while the zone is shared** ([FD-09]): the Free plan's one rate rule matches on path only, so it would also count the other product's requests. Fin's own limits stand alone. |

The API host is never in the plain-http rules: plain http reaches the edge there ([FD-03]).
Every rule names Fin's hosts only, because the zone is shared with another product. The path rule
refuses encoded dots because the edge decodes `%2e` before it removes dot segments, so
`/x/%2e%2e/api/ping` would be `/api/ping` at the edge and something else at the tunnel (S-01 (g)).

On a zone that is not shared, the rate rule is the last change of the run, after every deletion, so
a refusal of it (a plan limit, say) never stops a required rule.

## The safety rules it keeps

- Rules are written only through the per-rule endpoints (`POST .../rulesets/<id>/rules`,
  `PATCH` and `DELETE .../rules/<rule id>`), and only rules whose ref starts with `fin_next_`.
  A rule set is never replaced whole: one phase already holds another product's redirect rule.
- A phase entrypoint is created only when it does not exist, checked again just before.
- It refuses, before anything is sent, while a proxied wildcard record (`*.<zone>`, another
  product's) answers for a host that gets an ingress proof and has no record of its own yet: the
  zone rules come before the hosts' records (EXECUTION §2.5 steps 7 and 8), so that host's
  requests, with Fin's proof attached, would reach the wildcard's origin. Run `routes apply` first
  (each host's own record takes precedence over the wildcard) or resolve the wildcard with the
  owner. The wildcard itself is never touched.
- Every write is checked before the run registers (the guard, the endpoint, the object ID it
  names, and the body: a rule's ref and every hostname its expression names), so a refusal sends
  nothing. A stale rule whose ref starts with `fin_next_` is deleted whatever else its ref holds.
- Zone-wide settings (TLS minimum, 0-RTT, Always Use HTTPS, content rewrites and the rest of §5.11)
  change every host on the zone, the other product's included. On a shared zone they are planned
  and held unless the run passes `--allow-shared-zone-settings`; take that flag only after checking
  with the owner that the other product can live with each value (for example Always Use HTTPS off).
- Web Analytics, Zaraz, Markdown for Agents, Bot Fight Mode and Universal SSL are watched, not
  applied here.

## Ingress proofs

An existing proof is kept. A host with no proof gets a new one (32 random bytes, base64url). The
new proof is set first, sealed, as `FIN_INGRESS_PROOFS` on the services that check it (edge: api;
console; admin; verify: verify and selfie), and only then is the rule that sends it written. That
variable write needs `FIN_RAILWAY_TOKEN_FILE`, and Railway redeploys the services it touches.
Escrow comes before the variable in the plan; staging has no escrow recipient yet (BD-14), so a lost
proof is replaced by rotation (`rotate-ingress-proof.md`).

## Run it

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file> FIN_RAILWAY_TOKEN_FILE=<railway token file>
node ops/fin/src/main.ts zone apply staging --dry-run       # read the plan
node ops/fin/src/main.ts zone apply staging                 # rules; settings stay held
node ops/fin/src/main.ts zone apply staging --only settings --allow-shared-zone-settings   # only with the owner's yes
```

`--only rules` or `--only settings` applies one half. A stale `fin_next_` rule is deleted only with
`--confirm-delete <n>`.

The run's `run.done` record (in the run log) carries `rulesetHashes`: for each phase, the hash of
Fin's own rules, those whose ref starts with `fin_next_`, exactly as the watcher computes it
(`finRulesetHash`), so the other product's rules neither raise nor hide a change. The hashes are
never printed: a hash whose only unknown input is a private value (a threshold) could be reversed
offline from a job log. The watcher deploy reads them from the run log.

## Check it

- Re-run with `--dry-run`: it should print `nothing to change` for the rules (exit 0).
- `curl -sI http://<console host>/` answers 308 to https; a plain-http POST answers 403.
- `curl -s --path-as-is https://<console host>/x/../api/ping` answers 403, and so do
  `/x/%2e%2e/api/ping`, `/x/%2E%2E/api/ping` and `/x/.%2e/api/ping`.

## If it fails

The run stops at the failed write; everything before it stays applied and is in the run log.
Fix the cause and re-run: the plan reads the current state, so only what is missing is sent. A 4xx
naming a rule limit means the zone's plan has no room (5 custom rules, 1 rate rule on Free): stop
and tell the owner, never remove the other product's rules. A provider's error is printed masked
and names no rule or rule set ID (`<rule:fin_next_...>`, `<id>`). The private rate threshold is
redacted (`<threshold:api-v4>`) from the errors of the rate phase's writes, the only requests that
carry it; it is never registered with the masker, which would rewrite every equal number in the
output and the run log.
