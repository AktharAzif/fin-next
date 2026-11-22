# Spec 08: security, audit and observability (R9, R5)

| | |
|---|---|
| Status | Specification for builders, written on Saturday 21 Nov 2026. It is cross-cutting: Phase 0 builds its core, each day's lanes add to it, and the hardening workstreams finish it |
| Part of | The fin-next plan (R13): `docs/plan/ARCHITECTURE.md`, `docs/plan/DECISIONS.md`, `docs/plan/EXECUTION.md`. It details ARCHITECTURE §6.5 to §6.10, §7.8, §7.14, §8, §10 and §15, EXECUTION §1.6, §6 (H-04, H-05, H-06, H-09, H-12) and §7, and it indexes what specs 01 to 05 already define for their areas |
| Requirements touched | R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R12, R15, R16 (§0.2) |
| Lanes | P0-D, P0-E, P0-F, the steward, L-SAT-05, L-SAT-09, L-SUN-10, L-MON-09, and the hardening workstreams H-04, H-05, H-06, H-09 and H-12 (§11) |
| Exit | §13: A08-01 to A08-36; the production gates' evidence in §10 |

---

## 0. How to read this spec

### 0.1 Precedence, IDs and placeholders

**Precedence.** The plan's one order of precedence, highest first: (1) the owner's decisions of
21 Nov 2026; (2) DECISIONS.md, appendix C included; (3) ARCHITECTURE.md; (4) EXECUTION.md; (5) the
specifications, and between two specifications the one that owns the area, as README §8.3 lists
the owners.

1. The owner's decisions of 21 Nov 2026, which DECISIONS.md records, override every other text: the
   overnight ones, which spec 01 §1 lists as OD-1 to OD-6, and the answers of Saturday morning,
   which spec 01 §1.2 lists (§0.3 names what each changes here). The decisions taken while the owner
   was away, the build's [BD-01] to [BD-29] among them (BD-15 and BD-25 are withdrawn), are
   register entries (item 2), for the owner's review.
2. DECISIONS.md, appendix C included.
3. ARCHITECTURE.md.
4. EXECUTION.md.
5. The specifications. Between two of them, the one that owns the area holds. This spec owns the
   cross-cutting rules (§1.1): the shape of an audit row, the chain, the anchoring and the journal;
   the email classes and the digest; the personal-data classes and the scrubbers; the secrets
   inventory and the rotation runbooks; the line envelope, the transport, the alert file shape, the
   policies and the incident runbooks. On those rules it holds over specs 01 to 07, and §15 lists
   the reconciliations for the steward. Specs 02 to 05 own their own areas' events, templates, lines
   and alerts: the metadata, targets, triggers, recipients and copy. The names are the exception:
   §3.4 is the one list of audit event names and fragment files, and §4.4 the one list of template
   names and folders (D08-33). Specs 02, 03 and 05 use those names.

A decision of this spec (D08-nn, §14) binds where everything above it is silent; one that differs
from ARCHITECTURE.md or EXECUTION.md binds only once that file is changed to match. One that would
change a register entry binds only as DECISIONS appendix C settles it: D08-02 and D08-34 are folded
into [BC-03] (SF-10), and D08-32 into [P-07] (SF-01). A conflict with the register found later is
settled the same way, and the register holds until it is. Where this spec repeats a rule it names
the section it comes from and keeps it short; where it differs from ARCHITECTURE or EXECUTION, §14
says so, and the higher file holds until it is amended to match.

Anything marked **UNVERIFIED** is confirmed by the spike named beside it before work that depends on
it merges.

| ID form | Meaning | Register |
|---|---|---|
| `[XX-nn]` | A decision | DECISIONS.md, the only register |
| D6, in "moves to hardening (D6)" and "from hardening (D6)" | The owner's trim of Phase 0 on 21 Nov (§0.3): the builder account, the agents' own OS users, signed review receipts and the private overlay's ceremony move to hardening, before production. Not a research note, nor the 19 Nov plan's D6 | EXECUTION, "How to read this file"; spec 01 §1.2 |
| `OD-n` | An owner decision of 21 Nov 2026, by spec 01's short name; DECISIONS.md records each in its overnight table | spec 01 §1 |
| `D08-nn` | A decision this spec makes where the plan is silent | §14. D08-02, D08-32 and D08-34 are already settled in DECISIONS appendix C (SF-10, SF-01); the steward copies the rest into DECISIONS.md in a later pull request of the plan |
| `SF-nn` | A spec decision settled in the register before the first commit, folded or not adopted | DECISIONS appendix C |
| `TM-nn`, `TM-Lnn` | A threat-model attacker profile, and a stated limit | §2; `docs/security/threat-model.json` |
| `T08-nn` | A test this spec requires | §12 |
| `A08-nn` | An acceptance criterion | §13 |
| `PG-nn` | A production gate | EXECUTION §7.3. Production gates use `PG-` only; `G-` belongs to governance decisions |
| `SP-nn`, `S-nn` | A spike | ARCHITECTURE §11.11 and EXECUTION §2.6; each run's result in `docs/plan/spikes.md` |
| `CR-nn` | A credential or account the owner provides | EXECUTION §0.3 and §2.9 |
| `NB-nn` | A rule of the security bar that no cut line touches | EXECUTION §1.6 |
| `H-nn` | A hardening workstream | EXECUTION §6 |
| `F1` to `F24` | A data flow | ARCHITECTURE §2.3 |

| Placeholder | Stands for |
|---|---|
| `<zone>` | A Fin zone in general; production's zones are [FD-10]'s |
| `<staging-zone>` | The staging zone ([FD-09]): the shared zone that the old product's staging also uses |
| `<app>.<zone>` | A host by its role, for example `console.<zone>`. On staging each role has the name [FD-09] gives it: `admin.` is `staff.<staging-zone>`, `verify.` is `onboard.`, `developer.` is `docs.`, `api.` is `gateway.` and `db.` is `pg.`; `console.`, `selfie.`, `auth.` and `notify.` keep theirs |
| `<env>` | `staging` or `production` (and `development`, `ci` where named) |
| `<n>` | A key version number, starting at 1 |
| `<tunnel id>`, `<account id>`, `<team>`, `<aud>` | Values that live only in Cloudflare, Railway, Better Stack or the private overlay, never in the repository |

**Words.** *The overlay* is the private settings file that [G-09] lists ([OB-13]); it holds every
threshold, grace period, roster and zone name this spec refers to. Until hardening it is kept only
on the build machines (machine A and machine B), outside every repository, where `pnpm fin` and the
public-safety check read it; the ceremony (the owner giving it at the secure prompt, with its
encryption and escrow) moves to hardening (D6). *The secure prompt* is the only way a credential
reaches a command, except that until the owner is back `pnpm fin` reads the staging credentials the
owner gave there at about 08:37 on 21 Nov, and the vault's ops and state writer tokens minted from
them (CR-15), from their owner-only files on the build machine (§6.1, L1), wherever this spec takes
a staging credential from the secure prompt. *A registered run* is a `pnpm fin` run written to the
ops bucket before it changes anything (ARCHITECTURE §6.10).
*A unit* is one unit of work: an HTTP request, one run of a duty, one queue item, one process event,
one `pnpm fin` run, or one browser report (§7.2).

### 0.2 Requirements this spec touches

| Req | What this spec delivers for it | Where |
|---|---|---|
| R1 Production-ready, from scratch | The threat model and its check; the security, audit and monitoring parts of every production gate; written incident and rotation runbooks, each drilled once | §2, §8, §10 |
| R2 Everything on Railway, including the database | The audit chain, the sequencer, the journal and every duty run on Railway; only the outside witnesses (the R2 vault, Better Stack, the watcher) sit off Railway, as [P-02] allows | §3.6, §3.7, §7 |
| R3 Cloudflare Email Sending | The security email classes, the digest, the never-dropped rule and the email alerts over the one sender | §4, §7.8 group G |
| R4 Cloudflare in front of Railway | The tunnel-token threat (an interception credential), the minute watch, the evict runbook, the static-deployment watch, Logpush with its field allowlist | §2.4, §7.8 group B, §7.12, §8.2 |
| R5 Better Stack replaces Grafana and Sentry | The line schemas per unit, the transport, metrics, error tracking front and back with scrubbing, monitors, heartbeats, the alert set with first checks, policies, on-call, dashboards, monitoring as code | §7 |
| R6 Auth with roles | Sign-in, factor, step-up, staff and role events in the catalogue; the staff security emails; the auth alerts in the index | §3.4, §4.4, §7.8 group C |
| R7 Onboarding and go-live | Customer, person, RFI, go-live and staff decision events; reveal audit and budgets; personal-data handling with Sumsub as the record | §3.4, §5 |
| R8 Providers behind an adapter | Money events; `provider.call` written by every adapter, so a new provider is monitored by implementing the interface; the money alerts in the index | §3.4, §7.2, §7.8 group F |
| R9 Everything completely audited | The catalogue across every area and scope, the database-enforced write rule, the hash chain, the outside anchors, the revocation journal, retention, and the audit of the platforms themselves | §3 |
| R10 fin-review, fast CI | `monitoring:check`, `threat-model:check` and the scrubber tests run offline in `pnpm check` in under a second each; fin-review's own run lines and alerts | §7.11, §2.1 |
| R12 The public repository | No credential, threshold, roster, account or tunnel ID, Better Stack identifier or real person's data in any file this spec defines; the public-safety check knows every secret shape | §5.4, §6, §7.11 |
| R15 Bun or Node | Node 26.13.1 for every process; the scrubbers, the transport and `deliveryFetch`'s refusal tests also run in the Bun canary job | §7.3 |
| R16 The public API and docs | Try it's report path and its caps, the docs site's browser reports, and the API's lines and alerts in the index | §7.5, §7.8 group B |

### 0.3 What the owner's decisions of 21 Nov change here

| Decision | What it changes in security, audit and observability |
|---|---|
| OD-1 Tunnels for every host | A tunnel token is an interception credential: whoever runs a connector with it receives a share of real traffic, and rotating it does not evict running connectors. Hence the minute watch, the blue and green evict, and the exposure assessment after any rogue connector (§8.2) |
| OD-2 Assets-only static deployments | The static deploy token (CR-20) can replace every page of an environment. It is a family of its own (§6.2), watched every minute (`static-deployment-changed`), with a leak runbook. No Fin code runs at Cloudflare for an app, so the browser's errors and policy reports come back through each app's own `/api/monitoring/*` |
| OD-3 One origin per app | No CORS between an app and its API, so the envelope relay and the policy report endpoint are same-origin and read no cookie. The docs site reports to `api.<zone>/reports/docs` (spec 05 §8.13) |
| OD-4 Cookies and CSRF | The origin gate's refusals are a monitored signal: one `csrf.refused` line per refusal with its reason and route pattern ([SA-44]), watched by `csrf-refused-jump` (ARCHITECTURE §10.8, spec 02 §18.2); cookie values are a scrubber shape |
| OD-5 The UI SDK | No third-party origin at run time; the page policy has no nonce. `securitypolicyviolation` fails every browser test, and production reports reach `csp.report` lines |
| OD-6 The edge toggle | Nothing here |

The answers of Saturday morning (from about 08:25, build-clock times) and the decisions taken while
the owner was away change these parts. DECISIONS.md records each, and its away-time log ("Decided
while the owner was away") lists the steward's and the build's for the owner's review.

| Decision | Who decided | What it changes here |
|---|---|---|
| [AU-01] and [OB-18] take their defaults at the Saturday sitting | The owner, about 08:25 ("defaults") | §3.1; §15, items 1 and 3 |
| [FD-09]: staging lives on the shared staging zone, in the existing Cloudflare account, on new names | The owner, about 08:30. The staging names and the rules for the shared zone are the steward's, except the zone-rule writes ([BD-11]) and the DMARC records' policy and reports ([BD-17]), which are the build's | §0.1's placeholders; §2.5 (TM-L05, TM-L13); §7.8's `tunnel-config-drift`, `cloudflare-config-changed` and `email-setting-changed`; §7.12's staging filter; §8.5's static playbook |
| The staging accounts exist and their credentials are in, given at the secure prompt at about 08:37 | The owner, about 08:30 ("they exist") and 08:37, and about 08:49 ("ok") for revoking the Railway workspace token on Mon 23 Nov. Keeping them on the build machine until the owner is back, each in an owner-only file, is the build's practice, for the owner's review ([SA-22]). Renewing the Cloudflare operator token before it expires on Thu 26 Nov is an owner step, recorded by the steward | §0.1's words; §2.5 (TM-L16); §6.1 (L1) and §6.2; §7.5 |
| Phase 0 is trimmed: the builder account, the agents' own OS users, signed review receipts and the private overlay's ceremony move to hardening (D6) | The owner, about 08:25 ("yes"). [G-10]'s interim merge rule and keeping the private settings on the build machines are the steward's | §0.1's words; §2.2 to §2.4; §2.5 (TM-L15); §6.1, §6.2, §6.4 and §6.6 |
| fin-review runs locally as the merge gate until CI has an Anthropic credential | The owner, about 08:49 ("fine for now") | §2.3, §2.4 |
| Fin Admin's first staff admin on staging is the owner's staff address, never written here | The owner, about 08:49. Keeping its two TOTP secrets (Fin Admin's and Access's own factor) on the build machine and the staging-only mailbox rule are the steward's | §2.5 (TM-L14); §6.1 (L4) |
| The build's [BD-02], [BD-05], [BD-07], [BD-11], [BD-13], [BD-14], [BD-16] and [BD-17] | The build, under the owner's away-time authority, for the owner's review | §2.3, §2.4, §6.1, §6.2, §6.4, §6.6, §7.5, §7.8 and §8.5 |
| The build's [BD-24]: staging's Better Stack sources and Errors applications are in `us_west`, the only region the organisation offers, and staging's DSN check takes the `us_west` shape | The build, under the owner's away-time authority, for the owner's review; it departs from the owner's [OB-02], so that review covers it too | §7.1, §7.5 |

S-01 (SP-25) passed on 21 Nov (`docs/plan/spikes.md`), so §7.6's monitors follow its result and
the per-app API hosts stay only as the documented fallback.

---

## 1. Scope

### 1.1 This spec owns

| Area | Packages, apps and files | Sections |
|---|---|---|
| The threat model and its check | `docs/security/threat-model.md`, `docs/security/threat-model.json`, `docs/security/check.mjs` | §2 |
| The audit core: the registry, `recordAudit`, `audit.record()`, the guard installer, the sequencer, anchoring, verification, the revocation journal, restore markers and epochs | `packages/audit/src/{define,record,chain,anchor,verify,journal}.ts`, `packages/audit/src/events/platform.ts`, `packages/db/migrations/<ts>_audit_*.sql`, `apps/api/src/worker/audit/**` | §3 |
| The cross-area audit catalogue index (the area fragments stay with their lanes) | `packages/audit/src/events/*.ts` (index generated at build) | §3.4 |
| Security email classes, the digest and the cross-area email index | `packages/email/src/{classes,digest}.ts`, `packages/email/src/templates/ops/**` | §4 |
| Personal-data classes, the inventory, the scrubbers and the privacy-notice inputs | `packages/core/src/{scrub,safe-error}.ts`, `docs/security/personal-data.{md,json}` | §5 |
| Secrets, the key hierarchy, the credential inventory and the rotation runbooks | `ops/credentials.json`, `ops/fin/src/commands/{secret,rotate,escrow}/**`, `docs/runbooks/rotate-*.md` | §6 |
| Better Stack: line schemas, transport, metrics, errors and relays, monitors, heartbeats, the platform alerts, policies, on-call, dashboards, monitoring as code, Logpush | `packages/server/src/{telemetry/**,report.ts}`, `packages/web-host/src/monitoring/**`, `ops/monitoring/**` (index files and the `platform`, `audit`, `database`, `ops` fragments), `ops/watcher/**` | §7 |
| Incident runbooks: the tunnel token leak (evict), key rotation under pressure, the restore drill, and the playbook index | `docs/operations/incident-response.md`, `docs/runbooks/{evict-tunnel,rotate-emergency,restore-drill,restore-check}.md` and the playbooks of §8.5 | §8 |
| This area's evidence for the production gates | | §10 |

### 1.2 Other specs own

| What | Owner | This spec's interface to it |
|---|---|---|
| Sign-in, factor, step-up, team, role and staff events, templates, lines and alerts | Spec 02 §16 to §18 | Fragments `identity.ts`, `orgs.ts`, `staff.ts`; §3.3's row shape; §4's classes |
| Customer, person, RFI, go-live and staff decision events, templates, lines and alerts; the five places Sumsub is read | Spec 03 §8, §16 to §18 | Fragments `customers.ts`, `going-live.ts`, `staff-kyc.ts`, `staff-settings.ts`; §5's classes |
| Money events, templates, lines, alerts and the ledger head | Spec 04 §28 to §30 | Fragment `money.ts`; §3.7 anchors the ledger head |
| API key and webhook events, templates, lines and alerts; the docs reports | Spec 05 §4.10, §5.7, §8.13, §10 | Fragments `api-keys.ts`, `webhooks.ts` |
| Tunnels, the connector supervisor, the ingress check, static deployments, the Phase 0 watcher, the Phase 0 Better Stack team and files | Spec 01 §7 to §10 | §7 extends spec 01 §8 for production; §8.2 runs on spec 01 §7.3's commands |
| Kill switches by area | Specs 02 (`signups`), 03 (`hosted_verify`, `sumsub_writes`), 04 (`live_money`, `provider_instance:<instance>`), 05 (`live_keys`, `outbound_webhooks`); all of `api.` only by the Cloudflare rule `killswitch-api` ([OP-01]) | §8.6 lists them as containment tools |

### 1.3 When each part is built

| When | What | Lane |
|---|---|---|
| Phase 0 (Sat 08:00 to 13:30) | Scrubbers, the line envelope and transport, `reportError`, the envelope and policy relays; `audit.event`, `audit.record()`, the registry sync, the guard installer, the sequencer, `recordAudit`; the staging Better Stack team, sources, monitors, Phase 0 heartbeats and platform alerts; the watcher's front-door checks and its vault inventory; `ops/credentials.json` with its Phase 0 rows; `docs/security/threat-model.json` | P0-D, P0-E, P0-F, steward |
| Saturday | Auth events and emails, the digest and email classes, anchoring and the hourly verification, the revocation journal's table and shipper | L-SAT-02 to L-SAT-05, P0-E, L-SAT-09 |
| Sunday | KYC and webhook events; reveal budgets; the personal-data read lines; the `kyc.pd_read` budget alerts | L-SUN-02, L-SUN-04, L-SUN-08, L-SUN-10 |
| Monday | Money events, the ledger head anchor, money alerts | L-MON-01, L-MON-09 |
| Hardening (from Tue 24 Nov) | Journal replay on restore; the production watcher and its vault inventory; the GitHub settings check hourly; the Railway audit-log export; Logpush; the Cloudflare kill-switch rules (H-04). Every rotation command and runbook, the incident documents, the restore check and drill (H-05). The production team, paging, shadow mode, canary and test page, dashboards (H-06). Erasure, the privacy-notice inputs, the context sweep (H-09). Every drill (H-12) | H-04, H-05, H-06, H-09, H-12 |

---

## 2. Threat model

### 2.1 The files and the check

- `docs/security/threat-model.md` is the readable model: assets, trust boundaries, attacker profiles,
  stated limits, residual risks. `docs/security/threat-model.json` is the same model in a form a
  script can check. Both are written by the steward in Phase 0 (spec 01 §3.8) and changed in the
  same pull request as any change that adds a service, host, secret, database role, door operation,
  provider host or flow.
- **The JSON shape** (`docs/security/threat-model.schema.json` validates it):

  ```jsonc
  {
    "version": 1,
    "services":      [{ "name": "edge", "onRailway": true, "dbRole": "fin_edge", "tunnel": "public", "holds": ["FIN_CALLER_KEY_<n>", "API_KEY_PEPPER_<n>"] }],
    "hosts":         [{ "role": "console", "tunnel": "public", "static": "fin-next-<env>-console-static", "apiService": "console" }],
    "secrets":       [{ "family": "tunnel-token", "variables": ["TUNNEL_TOKEN"], "holders": ["cloudflared-public"] }],
    "dbRoles":       ["fin_edge", "fin_api", "fin_worker", "fin_payments", "fin_console", "fin_admin", "fin_backup", "fin_readonly", "fin_probe", "fin_owner"],
    "providerHosts": [{ "provider": "sumsub", "callers": ["api", "worker"] }],
    "doors":         [{ "callee": "api", "caller": "console", "operation": "console.customers.reveal" }],
    "flows":         ["F1", "F2"],
    "profiles":      [{ "id": "TM-01", "actor": "anyone on the internet", "goal": "...", "controls": ["ARCH §5.5"], "detection": ["ingress-untrusted-peer"], "tests": ["T08-40"] }],
    "limits":        [{ "id": "TM-L01", "text": "...", "decision": "[SA-36]" }]
  }
  ```

- **`threat-model:check`** (`docs/security/check.mjs`, in `pnpm check`, no network, under a second)
  fails when:
  1. a service in `ops/environments/<env>.json` is missing from `services`, or the reverse;
  2. a host role in `apps/connector`'s ingress map or a static deployment is missing from `hosts`;
  3. a credential name in `ops/credentials.json` is missing from `secrets`;
  4. a role in `packages/db/roles/grants/*.json` is missing from `dbRoles`;
  5. a provider host in an adapter's host allowlist (`packages/{kyc,money,email}/src/providers/*/hosts.ts`)
     is missing from `providerHosts`;
  6. a door operation in `packages/server/src/doors/*.ts` is missing from `doors`;
  7. a flow in `docs/flows/atlas.json` is missing from `flows`;
  8. a profile names a detection alert that `ops/monitoring/production/alerts/*.json` does not
     define, or a test ID that no test title in the repository starts with;
  9. a profile has no control, or a limit has no decision.

### 2.2 Assets

| ID | Asset | Why it matters | Where it is protected |
|---|---|---|---|
| AS-1 | Credentials: API keys, webhook secrets, provider tokens, tunnel tokens, signing keys, seal keys | Each one acts as someone or reads something | §6; ARCH §7.7, §7.8 |
| AS-2 | Sessions, factors and step-up proofs | They are the developer's and the staff member's identity | ARCH §7.1 to §7.4 |
| AS-3 | Personal data: names, details, documents, selfies, bank numbers, addresses | Legal duty; harm to real people | §5; ARCH §6.5 to §6.7 |
| AS-4 | Money: the ledger, transfers, beneficiaries | Loss is direct | ARCH §12 |
| AS-5 | The audit trail and the ledger's integrity | The record of who did what | §3 |
| AS-6 | Page integrity: the static files every browser runs | A changed page can steal every credential typed into it | ARCH §5.16; NB-14 |
| AS-7 | Availability: sign-in codes, hosted pages, payouts | Developers' customers are blocked | §7; ARCH §15 |
| AS-8 | Review integrity: the gate, fin-review's recorded runs (signed receipts from hardening, D6), the rules files | A weakened gate lets every other control be removed | ARCH §11.1, §11.6 |

### 2.3 Trust boundaries

| Boundary | Crossing | Control | Watched by |
|---|---|---|---|
| Internet to Cloudflare | Every request | TLS 1.2 and up, WAF, rate rules, Access on `admin.` | Logpush (§7.12), `cloudflare-config-changed` |
| Cloudflare to a connector | Every `/api/*` and `api.` request | Tunnel token on one connector service; fixed ingress map; `access.required` on admin | `tunnel-connectors`, `tunnel-config-drift` (watcher, every minute) |
| Connector to a service | Private network | Peer check and ingress proof (ARCH §5.5) | `ingress-untrusted-peer` |
| Service to service | Door calls | Ed25519 caller signatures with audience; the door matrix; callees re-check (ARCH §7.9) | `caller-signature-invalid`, `outside-request` |
| Service to Postgres | Every query | One group role per service; grant matrix; checked functions; audit guard (ARCH §6.3, §8.2) | `grants-drift`, `audit-guard`, `privileged-login` |
| Service to a provider | Outbound calls | Static egress allowlisted at the provider; host allowlists in each adapter; `deliveryFetch` for URLs a person supplied | `provider-auth-failing`, `sumsub-failing` |
| Operator to a platform | Every change | The secure prompt, registered runs, short-lived tokens | `deploy-outside-window`, `cloudflare-config-changed`, `github-settings-changed` |
| The operator machine or CI to staging | Deploys | Until the owner is back, `pnpm fin` from the operator machine, with registered runs and attested artefacts ([BD-05]); then the `staging` and `staging-static` environments, with the owner's approval ([CI-03]) | `deploy-outside-window`, `static-deployment-changed` |
| Builders to the repository | Merges | The ruleset (0 approvals and no code-owner review until hardening, [BD-02]); fin-review's recorded local run on the exact head until hardening ([G-10]), signed receipts from then (D6); control paths, whose owner approval GitHub enforces from hardening, with the review cadence and the away-time log standing in until then ([BD-02]) ([CI-01], [CI-11], [CI-14]) | `github-settings-changed` |
| Page to browser | Every document | `_headers` page policy, same origin, no third-party script (ARCH §7.12) | `csp.report` lines, the browser tests |
| Cloudflare static assets | Every file | Assets-only deployments; the static deploy token used only by `tools/static-deploy` ([BD-16]), and kept in one GitHub environment of its own once the environments exist ([BD-05]) | `static-deployment-changed` |

### 2.4 Attacker profiles

Each profile names its controls, how an attempt is seen, and the tests that prove the controls. The
attack pass of fin-review draws its profiles from this table and EXECUTION §1.7.

| ID | Actor and goal | Controls | Detection | Tests |
|---|---|---|---|---|
| TM-01 | Anyone on the internet reaching a service directly | No Railway public domain or TCP proxy; peer check and ingress proof (ARCH §5.5) | `railway-exposed`, `ingress-untrusted-peer` | T08-40, AC-P0-07 |
| TM-02 | A stranger who knows an address: enumeration, mail flooding | Same answers; per-recipient limits; Turnstile if approved (ARCH §7.5, §5.8) | `sign-in-failures-spike`, `email-volume-high` | spec 02 §19 |
| TM-03 | A signed-up stranger abusing Sandbox: mail, storage, cost | Sandbox mail rule, daily budgets, document quota ([SA-40], [DA-13]) | `email-budget-reached` | spec 03 §19 |
| TM-04 | A member or Admin exceeding their role | Server checks per permission; the outrank rule; step-up intents ([SA-32], NB-01, NB-02) | `step-up-failing`; the audit log | spec 02 §19 |
| TM-05 | A removed member holding a secret they saw | Credentials seen are rolled on removal ([SA-33]); the journal | `member.removed` metadata `credentialsRolled` | spec 02 §19 |
| TM-06 | A staff insider exceeding a granular role, or harvesting personal data | Granular staff permissions; reveal budgets; second approvers ([SA-12], [SA-39]) | `reveal-budget-reached`, `staff-changed` | spec 03 §19 |
| TM-07 | A copied cookie | Host-only `__Host-` cookies, `Strict` session; short staff sessions; trusted browsers revoked on change (ARCH §7.12) | `new-sign-in` email to the person | spec 02 §19 |
| TM-08 | Mail scanners using up links and codes | Codes in fragments; pages that never submit by themselves | none needed | spec 02 §19 |
| TM-09 | A neighbour on Railway's private network | Peer check plus proof; signed calls; no service trusts the network | `ingress-untrusted-peer`, `caller-signature-invalid` | T08-40, T08-41 |
| TM-10 | A holder of a leaked tunnel token | One token per tunnel on its own service; minute watch of count, version and origin; fixed ingress map; blue and green evict | `tunnel-connectors` (pages within 2 minutes) | A08-20, PG-05 |
| TM-11 | A holder of a leaked Railway credential or variable set | Each service holds only its secrets; callees hold only public keys; escrow off Railway; provider tokens limited to static egress | `deploy-outside-window`, `privileged-login` | §8.3 drill |
| TM-12 | A holder of a leaked Cloudflare token | Short-lived operator tokens; read-only watcher tokens; static deploy token scoped to Workers Scripts Edit | `cloudflare-config-changed`, `static-deployment-changed` | A08-21 |
| TM-13 | A holder of a leaked Better Stack token or heartbeat URL | No standing production token; heartbeats paired with a second check; the daily canary ([OB-10], [OB-17]) | `monitoring-drift`, the canary (§7.9) | T08-55 |
| TM-14 | A holder of a leaked Sumsub or MassPay credential | Tokens per holder, least permission, IP allowlists; leak runbooks | `sumsub-failing`, `provider-auth-failing` | §6.4 |
| TM-15 | A compromised edge, console or admin process | Callees re-check; `payments` re-reads keys; the audit guard; money keys need allowlists (ARCH §7.9 stated limit) | `audit-guard`, `money-door-volume` | spec 04 §33 |
| TM-16 | A forged provider or GitHub webhook | Signatures over raw bytes in constant time; body caps; replay windows (ARCH §7.10) | `sumsub-webhook-refused`, `provider-webhook-refused`, `secret-scanning-refused` | specs 03 to 05 |
| TM-17 | A hostile webhook receiver: SSRF, rebinding | `deliveryFetch` (ARCH §7.11, NB-12) | `webhook-host-capped` | spec 05 §13 |
| TM-18 | A co-tenant on shared static egress | Provider allowlists are one control among signatures and tokens; never the only one | none | none |
| TM-19 | A money replay or idempotency abuse | Three layers of idempotency; holds; the ledger (ARCH §12) | `idempotency-mismatch` (trips) | spec 04 §33 |
| TM-20 | A Sandbox key holder on the docs page | Try it on Sandbox keys only, five layers (spec 05 §9) | `docs-failing` | spec 05 §13 |
| TM-21 | A holder of the static deploy token, or a Cloudflare member, who attaches a Worker or replaces a page | Assets-only invariant; routes exact; watcher every minute; manifest hash equal to the release's (NB-14) | `static-deployment-changed` | A08-21 |
| TM-22 | The supply chain and the operator's machine | pnpm policy, pinned actions and images, attestations, the operator user with no agent (ARCH §7.13) | `github-settings-changed` | spec 01 §13 |
| TM-23 | A steered builder agent | Lane ownership; the ruleset (no push to `main`, merge commits only, no bypass actors); fin-review's recorded local run on the exact head ([G-10]); control paths, whose owner approval GitHub enforces from hardening, with the review cadence standing in until then ([BD-02]); no merge guard in Phase 0 ([BD-07]). Until hardening agents work with the owner's login: the builder account, signed receipts and the agents' own OS users come from hardening (D6) ([CI-11], [CI-13], [CI-14]) | `github-settings-changed` | AC-P0-13 (its builder-token half from hardening, D6) |
| TM-24 | Content a reviewer reads (prompt injection) | Review isolation and finding validation ([RV-21]) | fin-review's self-test | EXECUTION §2.4 |
| TM-25 | The CI pipeline attacker, including the staging deploy job | No secret in pull-request jobs; protected environments; owner approval ([CI-03]). Until the owner is back no CI job holds a deploy secret: staging deploys run from the operator machine ([BD-05]) | `deploy-outside-window` | AC-P0-30, AC-P0-31 |
| TM-26 | A cost attacker: ingest, email, calls | Load shedding; per-replica caps on browser reports; spending alerts at 80% | `telemetry-gaps`, `email-volume-high`, `load-shedding` | T08-31 |
| TM-27 | A stranger planting data in Better Stack through the report endpoints | Parse, scrub, cap; notify-only alerts above a volume ([SA-42]) | `browser-reports-lost` | T08-30 |
| TM-28 | Someone rewriting history: deleting or editing audit rows | Append-only triggers; `audit.record()` only; the chain; outside anchors; the watcher's vault inventory | `audit-chain-broken`, `audit-head-moved-back`, `vault-inventory-changed` | T08-05 to T08-12 |
| TM-29 | Someone undoing a revocation through a restore | The revocation journal replayed before serving ([AU-04]) | `journal-unshipped` | T08-14, §8.4 |
| TM-30 | A holder of the operator's database route | Zero connectors outside a registered run; Access TCP; a one-hour service token ([FD-11]) | `tunnel-connectors` (db tunnel) | PG-05 |

### 2.5 Stated limits

These are accepted, with the decision that accepts each. The threat model repeats them so a reviewer
never reports them as new.

| ID | Limit | Decision |
|---|---|---|
| TM-L01 | Code running inside the console can act for any live developer session, and could mint sessions and proofs; the audit guard makes it leave a row naming its login | [SA-36], ARCH §7.9 |
| TM-L02 | Code inside the edge can act as any key whose record it reads; `payments` re-reads keys and money keys carry allowlists | [SA-36], [MO-20] |
| TM-L03 | The HA superuser's password lives in the cluster's own variables | [P-18] |
| TM-L04 | A GitHub Actions log is public; nothing secret may be printed, and the overlay is masked value by value wherever `pnpm fin` reads it | [CI-03], spec 01 §9.2 |
| TM-L05 | Staging's watcher and vault live in the staging Cloudflare account, the existing account that the old product's staging also uses ([FD-09]) | [OB-11], [DA-09], [FD-09] |
| TM-L06 | One vendor holds the logs and the pager; liveness also rides on monitors, heartbeats and the watcher | [OB-01], ARCH §10.12 |
| TM-L07 | An R2 bucket lock can be lifted by whoever edits the bucket, probably without an audit entry; the watcher's inventory is the control | [DA-09] |
| TM-L08 | Email Sending is a beta with no support duty; its token can also edit suppressions | [EM-02] |
| TM-L09 | Railway's October 2026 breach exposed customers' variables, sealed ones included; every design here assumes variables leak | ARCH §1 principle 3 |
| TM-L10 | A direct misuse of a leaked service login that the audit guard refuses leaves an error in Postgres's own log, not a Better Stack line; the refusal itself is the control | D08-05 |
| TM-L11, TM-L12 | Two limits on paging and responders, with the owner's availability, kept in the threat model's private annex in the overlay ([G-09]); a reviewer reads them there | [OB-06], D08-24 |
| TM-L13 | Staging shares its zone and Cloudflare account with the old product's staging. The old product's Cloudflare credentials could change fin-next's staging DNS, routes and Access, and reach its account-level objects (tunnels, Workers scripts, R2 vault buckets, the tokens it minted; [DA-09]), and every host on the zone is same-site with every other, old and new; fin-next's cookies are host-only `__Host-`. Test data only; the zone-level risk is accepted until the cutover, and the account-level reach is for the owner to decide (DECISIONS, the away-time section) | [FD-09], [DA-09] |
| TM-L14 | On staging the first staff admin's two TOTP secrets, Fin Admin's and Access's own factor, are kept on the build machine, each in a local secret file outside every repository, never printed, logged or in CI, and agents may read that admin's mailbox for its Fin and Cloudflare sign-in emails (codes and links) and nothing else. So a steered agent can pass Access and sign in to Fin Admin on staging as that admin. Test data only. In production no agent holds any staff member's factor | [G-10] (staging only), [SA-04], [FD-05] |
| TM-L15 | Until hardening (D6) agents work with the owner's GitHub login, which can push workflow changes, merge, approve the staging environment and edit the ruleset. The review engine runs as the same OS user as the builders, so the spool is a queue, not a boundary, and no receipt is signed. The ruleset with no bypass actors, [G-10]'s interim merge rule, and [BD-02]'s review cadence and away-time log stand in | [CI-13], [CI-11], [G-10], [BD-02] |
| TM-L16 | Until the owner is back, the staging credentials the owner gave at the secure prompt at about 08:37 on 21 Nov, and the vault's ops and state writer tokens minted from them (CR-15), are kept on the build machine, each in an owner-only file readable by the user the agents' sessions run as, outside every repository, never printed, logged or in CI. So a steered agent could use them outside `pnpm fin`, whose allow-list then does not bind, and the Cloudflare operator token's zone and account permissions also reach the old product's resources on the shared account (EXECUTION §0.3, CR-05). They are staging and sandbox credentials only; the operator token expires on Thu 26 Nov, and the owner revokes the Railway workspace token on Mon 23 Nov | [SA-22], [FD-09] |

---

## 3. Audit (R9)

### 3.1 What is audited

R9 is read as [AU-01] reads it (ARCHITECTURE §8.1): an audit row for every write by any actor, every
reveal of personal data, documents or bank numbers, every sign-in, sign-out and session change, every
change to a sign-in method, and every important action in AGENTS terms; and an outside record of the
operator's database sessions and the platforms' own changes. The owner decided [AU-01] at its
default at the Saturday sitting (21 Nov, about 08:25, "defaults"), and that default is built.

| Kind of action | Audit row | Log line | Where |
|---|---|---|---|
| A write by a developer, an API key, a customer or person on a hosted link, staff, the operator or the system | yes, in the write's transaction | `request` or `job.run` | §3.3 |
| A reveal of personal data, a document or a bank number, and an API read of full deposit instructions | yes | `kyc.pd_read` or the area's line | specs 03 §8.1, 04 §11.4 |
| A sign-in, sign-out, session change or sign-in method change | yes, person or staff scope | `request` | spec 02 §16 |
| A list read or a record read that discloses nothing personal | no | one `request` line | [AU-01] |
| An API key check at the edge | no | `request` with `keyReason` | spec 05 §4.7 |
| A provider call | no (the state it changes is audited) | `provider.call`; a `money.provider_operation` row | ARCHITECTURE §8.1 |
| A sweep of expired rows | one `system.sweep_completed` row per table per run that deleted anything | `job.run` | D08-01 |
| A refusal that is not an action (a blocked endpoint, a gate refusal, a wrong enrolment code) | no | its security line | spec 02 §16.4 |
| An operator's `pnpm fin` run | its registration in the ops bucket; an audit row when it changes database rows | `run.registered`, `run.done` | §3.13 |
| A database login as `postgres` or `fin_owner` | a row in `ops.privileged_login` (superuser-owned) | `database.privileged_login` | ARCHITECTURE §6.3 |

### 3.2 The registry

- **Fragments.** Each area declares its events in `packages/audit/src/events/<area>.ts`, owned by the
  area's lane (EXECUTION §1.3), with `defineEvents` from `packages/audit/src/define.ts`:

  ```ts
  export type AuditScope = "organisation" | "person" | "staff";
  export type AuditCategory =
    | "sign_in" | "security" | "team" | "api_keys" | "organisation" | "customers"
    | "going_live" | "webhooks" | "money" | "staff" | "operations" | "system";
  export type ActorKind =
    | "user" | "api_key" | "staff" | "customer_link" | "person_link" | "system" | "provider" | "operator";
  export type ActorVia =
    | "console" | "api" | "hosted_pages" | "admin" | "job" | "webhook" | "reconciliation" | "operator";
  export type AuditRole =
    | "fin_edge" | "fin_api" | "fin_worker" | "fin_payments" | "fin_console" | "fin_admin" | "fin_owner";

  export interface EventSpec<M extends z.ZodObject> {
    category: AuditCategory;
    scope: AuditScope;
    roles: readonly AuditRole[];          // the login groups that may record it (audit.record() checks)
    actors: readonly ActorKind[];         // checked by recordAudit
    target: string;                       // the target ID's prefix, for example "mem", or "switch"
    metadata: M;                          // z.object({...}).strict(): flat values only (§3.3)
    journal?: { kind: JournalKind; when?: (m: z.infer<M>) => boolean };   // §3.10
    mirrorOf?: string;                    // a staff event that writes this organisation event too (spec 03 SD3-11)
  }

  export function defineEvents<const T extends Record<string, EventSpec<z.ZodObject>>>(
    area: string, events: T,
  ): T;
  ```

- **Names** match `^[a-z][a-z_]*(\.[a-z][a-z_]*){1,2}$`, are unique across every fragment, and are never
  reused for a different meaning. A retired event keeps its name in the fragment with `retired: true`,
  so old rows still resolve.
- **The index** (`AUDIT_EVENTS`, the name union `AuditEventName`) is generated at build by
  `pnpm --filter @fin/audit gen` into `packages/audit/src/events/_index.gen.ts`, which is git-ignored
  (EX-07). The generator fails on a duplicate name, an unknown category, scope or role, a metadata
  schema that is not a strict object of flat fields, or an event whose `roles` is empty.
- **The registry in the database.** `audit.event_type` holds `name`, `area`, `category`, `scope`,
  `roles text[]`, `retired boolean` and `synced_release`. After every migration run, the `migrate`
  service (as `fin_owner`) upserts it from the compiled `AUDIT_EVENTS` (`audit-sync` step). It adds
  and updates rows and never deletes one. Only `fin_owner` can write the table. A CI test compares the
  synced table with the TypeScript index after migrating a fresh database (T08-02).

### 3.3 The row

**`audit.event`** (migration `<ts>_audit_core.sql`, P0-E):

```sql
CREATE TABLE audit.event (
  id                    text PRIMARY KEY CHECK (id ~ '^aud_[0-9a-hjkmnp-tv-z]{26}$'),
  epoch                 integer NOT NULL,
  seq                   bigint,                                -- null until chained (§3.6); unique per epoch
  event                 text NOT NULL REFERENCES audit.event_type (name),
  category              text NOT NULL,                         -- stamped from audit.event_type
  scope                 text NOT NULL CHECK (scope IN ('organisation', 'person', 'staff')),
  organization_id       text,
  subject_user_id       text,                                  -- the person, for person scope
  mode                  text CHECK (mode IN ('sandbox', 'live')),
  actor_kind            text NOT NULL CHECK (actor_kind IN ('user', 'api_key', 'staff', 'customer_link',
                          'person_link', 'system', 'provider', 'operator')),
  actor_id              text,                                  -- usr_, key ID, stf_, lnk_, provider name, run ID
  actor_via             text NOT NULL CHECK (actor_via IN ('console', 'api', 'hosted_pages', 'admin', 'job',
                          'webhook', 'reconciliation', 'operator')),
  actor_key_id          text,
  actor_link_session_id text,
  step_up_kind          text CHECK (step_up_kind IN ('window', 'intent')),
  step_up_method        text CHECK (step_up_method IN ('passkey', 'totp', 'backup_code')),
  step_up_ref           text,                                  -- sti_ (intent) or asr_ (proof)
  target_id             text NOT NULL,
  ref_ids               text[] NOT NULL DEFAULT '{}' CHECK (cardinality(ref_ids) <= 32),
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id            text,
  release               text NOT NULL,
  db_login              text NOT NULL,                         -- session_user, stamped
  app_name              text NOT NULL,                         -- application_name, stamped
  backend_pid           integer NOT NULL,                      -- stamped
  xid                   xid8 NOT NULL,                         -- pg_current_xact_id(), stamped
  recorded_at           timestamptz NOT NULL,                  -- statement_timestamp(), stamped
  prev_hash             bytea,                                 -- set once by the sequencer
  hash                  bytea                                  -- set once by the sequencer
);
CREATE INDEX event_org_log    ON audit.event (organization_id, id DESC) WHERE scope = 'organisation';
CREATE INDEX event_person_log ON audit.event (subject_user_id, id DESC) WHERE scope = 'person';
CREATE INDEX event_staff_log  ON audit.event (id DESC) WHERE scope = 'staff';
CREATE INDEX event_target     ON audit.event (target_id, id DESC);
CREATE INDEX event_unchained  ON audit.event (xid, id) WHERE seq IS NULL;
CREATE UNIQUE INDEX event_epoch_seq ON audit.event (epoch, seq);
```

**`audit.event_context`** holds the client address and user agent that [BC-03] keeps for console and
Fin Admin actors, outside the chain, so their retention can differ from the event's (D08-02):

```sql
CREATE TABLE audit.event_context (
  event_id    text PRIMARY KEY REFERENCES audit.event (id),
  client_ip   inet,                                            -- CF-Connecting-IP, tunnel traffic only
  user_agent  text CHECK (length(user_agent) <= 400),
  created_at  timestamptz NOT NULL
);
```

**Append-only.** Triggers on `audit.event` refuse `DELETE` and `TRUNCATE` always, and refuse `UPDATE`
unless `current_user = 'fin_owner'` (true only inside the owner's `SECURITY DEFINER` functions or a
watched `fin_owner` login), `OLD.seq IS NULL`, and only `seq`, `prev_hash` and `hash` change from null
to a value. `audit.event_context` refuses `UPDATE` and allows `DELETE` only through
`audit.sweep_context()`. No service role holds `INSERT`, `UPDATE` or `DELETE` on any `audit` table.

**`audit.record(p jsonb) RETURNS text`**: `SECURITY DEFINER`, owned by `fin_owner`, `SET search_path
= audit, pg_temp`, `EXECUTE` granted to the group roles `fin_api`, `fin_worker`, `fin_payments`,
`fin_console` and `fin_admin`, revoked from `PUBLIC`. In order, it:

1. reads the keys `id`, `event`, `actor_kind`, `actor_id`, `actor_via`, `actor_key_id`,
   `actor_link_session_id`, `step_up_kind`, `step_up_method`, `step_up_ref`, `target_id`, `ref_ids`,
   `organization_id`, `subject_user_id`, `mode`, `metadata`, `request_id`, `release` and `context`,
   and refuses any other key;
2. looks up `event` in `audit.event_type`; unknown or retired raises `FA001`;
3. checks that `session_user` is a member of one of the event's `roles`
   (`pg_has_role(session_user, r, 'MEMBER')`); otherwise `FA002`;
4. checks the scope: `organisation` needs `organization_id`, `person` needs `subject_user_id`;
   otherwise `FA003`;
5. checks `metadata`: a JSON object whose values are strings of at most 200 characters, numbers,
   booleans, nulls, or arrays of at most 50 of those; keys match `^[a-z][A-Za-z0-9_]{0,63}$`; at most
   4 KB as text; otherwise `FA004`;
6. checks `ref_ids` (at most 32) and the `id` shape; otherwise `FA005`;
7. inserts the row, stamping `epoch` from the current `audit.head` row, `category` and `scope` from
   the registry, `db_login`, `app_name`, `backend_pid`, `xid` and `recorded_at`;
8. inserts `audit.event_context` only when `context` is given and `actor_via` is `console` or
   `admin`;
9. sends `NOTIFY audit_written` (no payload) and returns the ID.

SQLSTATE class `FA` is Fin's audit class: `FA001` unknown or retired event, `FA002` role not allowed,
`FA003` scope fields missing, `FA004` metadata shape, `FA005` refs or ID, `FA010` the guard (§3.5).

**`recordAudit()`** (`packages/audit/src/record.ts`), the only caller in application code:

```ts
export async function recordAudit<E extends AuditEventName>(tx: UnitTx, input: {
  event: E;
  actor: {
    kind: ActorKind; id: string | null; via: ActorVia;
    keyId?: string; linkSessionId?: string;
    stepUp?: { kind: "window" | "intent"; method: "passkey" | "totp" | "backup_code"; ref: string };
  };
  target: string;
  refs?: readonly string[];
  organizationId?: string;
  subjectUserId?: string;
  mode?: "sandbox" | "live";
  metadata: z.input<AuditEvents[E]["metadata"]>;
  context?: { clientIp: string | null; userAgent: string | null };
}): Promise<AuditEventId>;
```

- It makes the `aud_` ID from the unit's `Clock`, takes `requestId` and `release` from the unit's
  context, checks `actor.kind` against the event's `actors`, parses `metadata` with the event's strict
  schema, and runs `assertNoPersonalShapes` (§5.4) over every string value: an email address, an IP
  address, a token or key shape, a URL with a query, or a run of nine or more digits throws
  `AuditMetadataError` before any SQL.
- It writes the journal entry the event declares (§3.10) in the same transaction.
- It must run inside the action's transaction (`UnitTx`); a call outside one is a type error. On any
  `FA` error the transaction rolls back, the unit writes `audit.write_failed` (`event`, `sqlstate`),
  and the action fails with a 500 that carries only the request ID.
- A library-driven event that Better Auth's hooks cannot place in the write's transaction follows
  spec 02 §3.5.

**Metadata rules** (ARCHITECTURE §8.2): IDs, statuses, codes, counts, amounts in minor units, field and
page names, role and permission keys before and after, reason codes and preset wording, template
IDs, a note's ID, an idempotency key's SHA-256. Never a secret, code, token, password, account
number, last four digits, name, email address, phone, message, note, link, URL with a path, or any
text a person typed. A webhook URL is kept as its host only. Keys may be camelCase or snake_case as
each area spec writes them; new fragments use snake_case (D08-03).

### 3.4 The catalogue across every area

Every event Fin records, by fragment. 218 events in all. **This table is the canonical list of
event names and fragment files (D08-33)**: the event generator, T08-16 and `monitoring:check` are
built against it, and specs 02 to 05 use its names. The metadata, targets and triggers of area events
are in the area spec named. A name is added, renamed or retired here and in its area spec in the same
reviewed change; a builder who finds the two differing stops and asks the steward, and never picks
one. An event name is never also a permission key (spec 02 §8.2): the Sandbox reset is the event
`customer.sandbox_reset` behind the permission `sandbox.reset`.

| Fragment (owner lane) | Spec | Scope | Category | Recorded by | Events |
|---|---|---|---|---|---|
| `identity.ts` (L-SAT-02) | 02 §16.2 | person | `sign_in` | `fin_console` | `session.created`, `session.ended`, `session.revoked`, `session.revoked_others`, `sign_in.second_factor_required`, `sign_in.failed`, `sign_in.second_factor_failed`, `sign_in.locked` |
| `identity.ts` (L-SAT-02) | 02 §16.2 | person | `security` | `fin_console`; also `fin_api` for the staff path of recovery and for `browser.trust_revoked` at a go-live approval, and `fin_worker` for finishing or lapsing a recovery (02 §6.6, §6.8) | `user.created`, `user.name_changed`, `two_factor.setup_started`, `two_factor.enabled`, `two_factor.disabled`, `backup_codes.regenerated`, `backup_code.used`, `passkey.added`, `passkey.removed`, `step_up.passed`, `step_up.failed`, `step_up.locked`, `browser.trusted`, `browser.trust_revoked`, `password.set`, `password.changed`, `password.reset_requested`, `password.reset`, `password.reset_failed`, `password.paused`, `account.linked`, `account.unlinked`, `account.recovery_started`, `account.recovery_approved`, `account.recovery_finished`, `account.recovery_cancelled` |
| `orgs.ts` (L-SAT-03) | 02 §16.3 | organisation | `organisation`, `team` | `fin_console` | `organization.created`, `organization.updated`, `organization.deleted`; `member.invited`, `member.invitation_changed`, `member.invitation_resent`, `member.invitation_cancelled`, `member.invitation_declined`, `member.joined`, `member.role_changed`, `member.removed`, `member.signed_in`, `member.second_factor_added`, `member.second_factor_removed`, `member.name_changed`, `role.created`, `role.updated`, `role.deleted` |
| `staff.ts` (L-SAT-04) | 02 §16.4 | staff | `sign_in`, `security`, `staff` | `fin_admin` (`staff.bootstrapped`: `fin_owner`) | `staff.signed_in`, `staff.second_factor_required`, `staff.signed_out`, `staff.session_revoked`, `staff.signed_out_everywhere`, `staff.sign_in_failed`, `staff.step_up_passed`, `staff.step_up_failed`, `staff.step_up_locked`, `staff.factor_setup_started`, `staff.factor_added`, `staff.factor_removed`, `staff.factor_enrolled`, `staff.enrolment_code_issued`, `staff.enrolment_code_redeemed`, `staff.member_added`, `staff.role_changed`, `staff.member_removed`, `staff.factors_reset`, `staff.role_created`, `staff.role_updated`, `staff.role_deleted`, `staff.bootstrapped` |
| `staff.ts` (L-SAT-04) | 02 §16.4 | staff | `operations` | `fin_admin`, `fin_owner` (`pnpm fin switch`) | `switch.set`, `switch.cleared` |
| `api-keys.ts` (L-SAT-11) | 05 §4.10 | organisation | `api_keys` | `fin_console`; `fin_api` for exposures | `api_key.created`, `api_key.updated`, `api_key.rolled`, `api_key.revoked`, `api_key.exposed` |
| `webhooks.ts` (L-SUN-04) | 05 §5.7 | organisation | `webhooks` | `fin_api`, `fin_worker` (system) | `webhook_endpoint.created`, `webhook_endpoint.updated`, `webhook_endpoint.events_changed`, `webhook_endpoint.url_changed`, `webhook_endpoint.secret_rolled`, `webhook_endpoint.deleted`, `webhook_endpoint.test_sent`, `webhook_endpoint.verified`, `webhook_endpoint.verification_failed`, `webhook_endpoint.paused`, `webhook_endpoint.disabled`, `webhook_endpoint.resumed`, `webhook_delivery.retried` |
| `customers.ts` (L-SUN-02) | 03 §16.2 | organisation | `customers` | `fin_api`; `fin_worker` (provider, system) | `customer.created`, `customer.updated`, `customer.details_entered`, `customer.consent_given`, `customer.link_created`, `customer.assisted_link_created`, `customer.link_opened`, `customer.link_emailed`, `customer.details_shown`, `customer.submitted`, `customer.status_changed`, `customer.document_added`, `customer.document_status_changed`, `customer.person_added`, `customer.person_updated`, `customer.person_removed`, `customer.person_link_created`, `person.details_entered`, `person.submitted`, `person.link_opened`, `person.status_changed`, `customer.rfi_opened`, `customer.rfi_draft_saved`, `customer.rfi_form_sent`, `customer.rfi_note_added`, `customer.rfi_documents_added`, `customer.rfi_answered`, `customer.rfi_accepted`, `customer.rfi_more_needed`, `customer.rfi_changed`, `customer.rfi_cancelled`, `customer.rfi_expired`, `customer.selfie_started`, `customer.selfie_completed`, `customer.test_data_created`, `customer.sandbox_action`, `customer.restarted`, `customer.deleted`, `customer.erased`, `customer.sandbox_reset` |
| `going-live.ts` (L-SUN-02) | 03 §16.3 | organisation | `going_live` | `fin_api`; `fin_worker` (provider) | `go_live.started`, `go_live.answers_saved`, `go_live.company_email_code_sent`, `go_live.company_email_checked`, `go_live.person_added`, `go_live.person_removed`, `go_live.person_link_created`, `go_live.company_added`, `go_live.company_removed`, `go_live.terms_accepted`, `go_live.submitted`, `go_live.person_status_changed`, `go_live.provider_status_changed`, `organization.live_status_changed` |
| `staff-kyc.ts` (L-SUN-02) | 03 §16.4 | staff | `staff`, `system` | `fin_api`; `fin_worker` (system) | `staff.customer_approved`, `staff.customer_unapproved`, `staff.customer_rejected`, `staff.customer_restart_allowed`, `staff.customer_details_shown`, `staff.document_viewed`, `staff.rfi_created`, `staff.rfi_accepted`, `staff.rfi_more_needed`, `staff.rfi_withdrawn`, `staff.rfi_changed`, `staff.form_created`, `staff.form_updated`, `staff.form_published`, `staff.form_archived`, `staff.fin_approval_enabled`, `staff.fin_approval_disabled`, `staff.go_live_first_approval`, `staff.go_live_approved`, `staff.go_live_changes_requested`, `staff.go_live_declined`, `staff.organization_paused`, `staff.organization_restore_requested`, `staff.organization_restored`, `staff.approval_cancelled`, `staff.approval_expired`, `staff.flag_resolved`, `staff.reveal_budget_reached`, `system.kyc_write_refused`, `system.kyc_unknown_applicant` |
| `staff-settings.ts` (L-SUN-08) | 03 §16.4 | staff | `staff` | `fin_admin` | `staff.reason_preset_added`, `staff.reason_preset_renamed`, `staff.reason_preset_moved`, `staff.reason_preset_retired`, `staff.reason_preset_restored`, `staff.message_template_added`, `staff.message_template_changed`, `staff.message_template_retired`, `staff.message_template_restored`, `staff.saved_view_created`, `staff.saved_view_deleted` |
| `money.ts` (L-MON-01) | 04 §28 | organisation | `money` | `fin_payments`; `fin_api` for `money.holder_details_shared` | `money.holder.created`, `money.holder.state_changed`, `money.holder_details_shared`, `virtual_account.requested`, `virtual_account.opened`, `virtual_account.open_failed`, `virtual_account.closed`, `virtual_account.instructions_revealed`, `beneficiary.added`, `beneficiary.removed`, `transfer.created`, `transfer.status_changed`, `transfer.cancel_requested`, `transfer.simulated` |
| `money.ts` (L-MON-01) | 04 §28 | staff | `money` | `fin_payments` | `money.holder.retry_requested`, `money.routing_decided`, `beneficiary.sealed_opened`, `beneficiary.registered`, `treasury.funding_created`, `money.reconciliation_break`, `money.reconciliation_break_resolved` |
| `platform.ts` (P0-E, this spec) | §3.4 below | staff | `operations`, `system` | as below | `switch.tripped`, `audit.epoch_started`, `audit.restore_replayed`, `audit.failover_recorded`, `operator.task_completed`, `operator.credential_rotated`, `operator.escrow_opened`, `system.sweep_completed` |

**This spec's fragment, `platform.ts`:**

| Event | Category | Recorded by | Actor | Target | Metadata |
|---|---|---|---|---|---|
| `switch.tripped` | `operations` | `fin_payments`, `fin_worker` (inside `ops.trip_switch()`) | `system`, `via: reconciliation` or `job` | the switch name | `reasonCode` (`idempotency_mismatch`, `sent_after_end`, `orphan_payout`, `reconciliation_break`), `ref` (the transfer or break ID) |
| `audit.epoch_started` | `system` | `fin_owner` | `operator` | `epoch:<n>` | `reason` (`created`, `restore`, `reset`, `failover`), `previousEpoch`, `previousSeq`, `markerKey` |
| `audit.restore_replayed` | `operations` | `fin_owner` | `operator` | the restore marker key | `automatic`, `confirmed`, `skipped` (counts by journal kind, as `kind:count` strings) |
| `audit.failover_recorded` | `system` | `fin_owner` | `operator` | `epoch:<n>` | `lastAnchoredSeq`, `newTimeline`, `markerKey` |
| `operator.task_completed` | `operations` | `fin_owner` | `operator` (`actor_id` the run ID) | the task name | `task`, `rowsChanged`, `release` |
| `operator.credential_rotated` | `operations` | `fin_owner` | `operator` | the family name | `family`, `version`, `services` (names), `overlapEnds` |
| `operator.escrow_opened` | `operations` | `fin_owner` | `operator` | the family name | `family`, `version`, `incidentRef` |
| `system.sweep_completed` | `system` | `fin_worker` | `system`, `via: job` | the table name | `deleted`, `olderThan` (an ISO 8601 duration) |

The `operator.*` events are written by `migrate --task audit-note` at the end of a registered run,
when the database is reachable; when it is not, the run registration in the ops bucket is the record
and the note is written when the database returns (D08-04).

### 3.5 The guard: no critical write without its event

- **Installer.** `audit.install_guard(p_table regclass, p_ops text[], p_key_column name, p_events
  text[])`, owned by `fin_owner` and run only by migrations, creates a `CONSTRAINT TRIGGER ... AFTER
  <ops> ON <table> DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION
  audit.require_event('<key column>', '<events>')`. An operation may be `INSERT`, `DELETE` or
  `UPDATE OF <columns>`.
- **The check** at commit: `EXISTS (SELECT 1 FROM audit.event WHERE xid = pg_current_xact_id() AND
  seq IS NULL AND (target_id = key OR key = ANY (ref_ids)) AND event = ANY (events))`, using
  `event_unchained`. A miss raises `FA010` with the table name only (never the row's values), and the
  commit fails. The unit of work catches `FA010` and writes `database.audit_guard` (`table`), which
  pages (`audit-guard`). A direct misuse of a leaked login gets the same refusal, recorded only in
  Postgres's own log (TM-L10).
- **Registrations** live in `packages/db/src/guards/<area>.ts` (`{ table, ops, keyColumn, events }`),
  owned by the area's lane; the area's migration calls `audit.install_guard` with the same values, and
  the guard test (T08-06) compares every registration with `pg_trigger` and proves each refuses a
  commit without its event. The guarded tables are spec 02 §13.8's (identity, staff, keys), spec 03
  §4.7's (kyc, `identity.organization.live_status`, `events.webhook_endpoint`) and spec 04 §7.7's
  (beneficiaries, transfers, ledger entries), and one this spec adds:

  | Table | Operations | Key column | Accepted events |
  |---|---|---|---|
  | `ops.kill_switch` | INSERT, UPDATE OF `state` | `name` | `switch.set`, `switch.cleared`, `switch.tripped` |

### 3.6 The chain

- **No lock on the write path** ([AU-02], ARCHITECTURE §8.3). Rows are inserted with `seq`, `prev_hash`
  and `hash` null.
- **The sequencer** is `audit.sequence(p_max integer DEFAULT 5000) RETURNS integer`, `SECURITY
  DEFINER`, owned by `fin_owner`, `EXECUTE` to `fin_worker` only. It locks the current `audit.head`
  row (`FOR UPDATE`), selects up to `p_max` rows `WHERE seq IS NULL ORDER BY xid, id FOR UPDATE`
  (only committed rows are visible, so a row of an open transaction waits for the next pass), and for
  each assigns `seq = head.seq + 1`, `prev_hash = head.hash`, `hash = audit.row_hash(row, prev_hash)`,
  then moves the head. It returns the count.
- **Where it runs.** A loop in `worker` (`apps/api/src/worker/audit/sequencer.ts`), active only while
  that replica holds the worker's scheduler lease, calls it every second. It writes one `job.run`
  line a minute (`job: "audit-sequencer"`, `processed`, `runs`, `oldestUnsequencedS`), not one a
  second (D08-06).
- **The hash, version 1** (`audit.row_hash`, recomputed in `packages/audit/src/chain.ts`). SHA-256
  over the concatenation of these fields in this order, each encoded as a 4-byte big-endian length
  followed by its UTF-8 bytes, a null as the 4 bytes `FF FF FF FF` with nothing after:

  1. the literal `fin-audit-v1`
  2. `epoch` (decimal)
  3. `seq` (decimal)
  4. `prev_hash` (32 raw bytes)
  5. `id`, `event`, `category`, `scope`, `organization_id`, `subject_user_id`, `mode`
  6. `actor_kind`, `actor_id`, `actor_via`, `actor_key_id`, `actor_link_session_id`
  7. `step_up_kind`, `step_up_method`, `step_up_ref`
  8. `target_id`
  9. `ref_ids`: the count (decimal), then each element as its own field
  10. `metadata::text` (Postgres's own `jsonb` text form; the verifier reads this text from the
      database and never re-serialises JSON)
  11. `request_id`, `release`, `db_login`, `app_name`, `backend_pid` (decimal), `xid` (decimal)
  12. `recorded_at` as `to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`

  The length of a field is `int4send(octet_length(value))`. The first row of epoch 1 takes
  `prev_hash` = 32 zero bytes; the first row of a later epoch takes the `start_prev_hash` of its head
  row (§3.9).
- **Head.** `audit.head (epoch integer PRIMARY KEY, seq bigint NOT NULL, hash bytea NOT NULL,
  moved_at timestamptz NOT NULL, started_at timestamptz NOT NULL, start_reason text NOT NULL,
  start_prev_hash bytea NOT NULL, marker_key text, current boolean NOT NULL)`, with a unique partial
  index on `current` so exactly one epoch is current. Only the sequencer and `audit.start_epoch()`
  write it.
- **The independent age.** `audit.unsequenced_age() RETURNS integer` (seconds since the oldest
  unchained row, 0 when none), `SECURITY DEFINER`, `EXECUTE` to `fin_probe`, so the database probe
  reports it even when the sequencer has stopped (`audit-unsequenced`).

### 3.7 Anchoring: the heads outside the database

- **Audit head** ([AU-03], ARCHITECTURE §8.4). The `audit-anchor` duty (worker, every minute after the
  sequencer's pass) reads the current head; if it moved since the last anchor, it PUTs to the R2
  bucket `fin-next-<env>-audit`, with `If-None-Match: *`, the object
  `audit/head/e<epoch>/<seq, 12 digits>-<first 16 hex of the hash>.json`:

  ```json
  { "kind": "audit", "environment": "<env>", "epoch": 1, "seq": 48213,
    "hash": "<64 hex>", "movedAt": "2026-11-21T10:02:00.000000Z", "release": "<sha>" }
  ```

  A 200 inserts `audit.anchor (kind, epoch, seq, hash, object_key, written_at)`. A 412 reads the
  object back: equal content counts as written; different content writes `audit.anchor_conflict`
  and pages (`audit-anchor-failing`). Every anchor also ships an `audit.head` line (`epoch`, `seq`,
  `hash`) to Better Stack, the second witness.
- **Ledger head.** Once a day at 00:05 UTC the same duty reads `money.ledger_head_v` (spec 04 §9.5,
  MS-14; `fin_worker` holds `SELECT` on that view only) and writes
  `ledger/head/e<epoch>/<seq, 12 digits>-<first 16 hex>.json` the same way, with a `ledger.head` line.
- **Locks.** One year in staging; Indefinite in production by default, still [AU-03]'s owner decision.
  The worker's R2 token (`FIN_VAULT_AUDIT_*`) writes this bucket only.

### 3.8 Verification

The `audit-check` duty (worker, hourly) and `pnpm fin verify` (daily, read-only credentials) run the
same verifier, `packages/audit/src/verify.ts`:

1. Read `audit.check_state` for `chain` (`epoch`, `last_seq`, `last_hash`).
2. Stream `audit.event` rows of the current epoch with `seq > last_seq ORDER BY seq`, selecting
   `metadata::text`, recompute each hash, and check `prev_hash` links, no gap in `seq`, and the
   stored `hash`. A difference writes `audit.check_failed` (`reason`: `hash`, `link`, `gap`).
3. List the R2 objects under `audit/head/` added since the last run. For each, the row with that
   `epoch` and `seq` exists with that hash (else `audit.check_failed reason=anchor_mismatch`); within
   an epoch, anchors only grow (else `audit.head_moved_back`); the chain recomputed from one anchor
   reaches the next (else `audit.head_not_extending`).
4. Compare the database head with the newest anchor: the head's `seq` is at least the anchor's (else
   `audit.head_moved_back`).
5. Repeat steps 3 and 4 for `ledger/head/` against `money.ledger_head_v`.
6. Write `audit.check` (`result`, `epoch`, `checkedFrom`, `checkedTo`, `anchors`), update
   `audit.check_state`, and ping the `audit-check` heartbeat (`/fail` on any failure).

**Epochs are checked from outside.** The watcher's `audit-epochs` check (hardening, H-04) lists the
epoch prefixes under `audit/head/` and the newest marker under `ops/restore/` (and, in staging,
`ops/reset/`) with its read-only vault inventory token, and fails when any epoch exists that no
marker started, or the newest epoch is not the newest marker's (`audit-epoch-unexpected`, P in
production) (D08-07).

**Better Stack's copy.** The alert `audit-head-line-regressed` compares each `audit.head` line's `seq`
with the largest `seq` seen in the last 7 days for the same `environment` and `epoch`, and fires when
it is smaller.

### 3.9 Epochs, failovers, restores and resets

- An epoch starts only through `audit.start_epoch(p_reason text, p_prev_hash bytea, p_marker_key
  text)`, `EXECUTE` to `fin_owner` only, called by a registered `migrate --task` run. It inserts the
  new `audit.head` row (`seq` 0, `hash` = `p_prev_hash`, `current` true), clears `current` on the
  old one, and records `audit.epoch_started` as the new epoch's first row.
- **Environment creation**: epoch 1, reason `created`, `p_prev_hash` 32 zero bytes, marker
  `ops/restore/<time>-created.json`.
- **Restore** (ARCHITECTURE §15.3, §8.5): the operator writes `ops/restore/<yyyymmddThhmmssZ>.json`
  before the restored database serves:

  ```json
  { "environment": "<env>", "kind": "restore", "source": "pitr", "restorePoint": "<RFC 3339>",
    "previousEpoch": 1, "previousHeadSeq": 48200, "previousHeadHash": "<64 hex>",
    "newEpoch": 2, "startedAt": "<RFC 3339>", "operatorRun": "<run id>" }
  ```

  `previousHeadSeq` and `previousHeadHash` are the restored database's own head after verification.
  Then `audit.start_epoch('restore', <previousHeadHash>, <marker key>)`, the journal replay (§3.10),
  and a second marker write with `completedAt` and the replay counts. Each service's `/readyz` refuses
  until the marker has `completedAt` (it reads a row `ops.restore_state` that the same task sets).
- **Failover with lost commits** (ARCHITECTURE §8.4): when `failover-detected` fires and the verifier
  reports `audit.head_moved_back`, the operator follows `docs/runbooks/failover-lost-commits.md`:
  write a failover marker naming the last anchored `seq`, start a new epoch with reason `failover`,
  record `audit.failover_recorded`, and list the anchored but lost range in the incident from the R2
  anchors and Better Stack's `audit.head` lines.
- **Staging reset**: a reset marker under `ops/reset/`, reason `reset`. Production refuses
  `start_epoch('reset', ...)`: the function checks `FIN_ENVIRONMENT` passed by the task against a
  row the bootstrap wrote, and the task refuses before calling it.

### 3.10 The revocation journal

- **What.** Every access-removing action also writes a journal entry with IDs and the time only
  ([AU-04], ARCHITECTURE §8.5). An event's `journal` field declares it, so `recordAudit` writes the
  entry in the same transaction and no caller can forget it.
- **Tables.** `audit.journal_entry (id text PRIMARY KEY CHECK (id ~ '^jrn_[0-9a-hjkmnp-tv-z]{26}$'),
  epoch integer NOT NULL, kind text NOT NULL, organization_id text, subject_ids text[] NOT NULL,
  audit_event_id text NOT NULL REFERENCES audit.event (id), recorded_at timestamptz NOT NULL)`,
  append-only like `audit.event`; and `audit.journal_shipped (entry_id text PRIMARY KEY REFERENCES
  audit.journal_entry (id), object_key text NOT NULL, shipped_at timestamptz NOT NULL)`, written by
  the shipper. Both are written only through `SECURITY DEFINER` functions.
- **Shipping.** The `journal-ship` duty (worker, on `NOTIFY audit_journal` and every minute) PUTs each
  unshipped entry to `journal/e<epoch>/<recorded_at as yyyymmddThhmmssZ>-<jrn id>.json` in the audit
  bucket with `If-None-Match: *`, then records it as shipped. An entry unshipped for 5 minutes pages
  (`journal-unshipped`).

| Journal kind | Written with | Restore replay |
|---|---|---|
| `key_revoked` | `api_key.revoked` | automatic: set `revoked_at` again |
| `key_rolled` | `api_key.rolled` | automatic: the old key's end set to the roll's end |
| `sessions_ended` | `session.revoked_others`, `password.reset`, `account.recovery_finished`, `staff.signed_out_everywhere` | none needed: a restore ends every session; recorded for the count |
| `member_removed` | `member.removed` | automatic |
| `invitation_cancelled` | `member.invitation_cancelled` | automatic |
| `role_lowered` | `member.role_changed` and `role.updated` when permissions were removed | printed for the owner's confirmation |
| `organisation_deleted` | `organization.deleted` | automatic |
| `organisation_paused` | `staff.organization_paused` | automatic |
| `factor_removed` | `passkey.removed`, `two_factor.disabled`, `staff.factor_removed` | automatic |
| `trusted_browser_revoked` | `browser.trust_revoked` | automatic |
| `staff_removed` | `staff.member_removed` | automatic |
| `staff_factors_reset` | `staff.factors_reset` | automatic |
| `staff_role_lowered` | `staff.role_changed`, `staff.role_updated` when permissions were removed | printed for the owner's confirmation |
| `links_revoked` | `customer.restarted`, `customer.deleted` | automatic |
| `customer_erased` | `customer.deleted`, `customer.erased` | automatic: the erasure re-applied |
| `webhook_secret_rolled` | `webhook_endpoint.secret_rolled` | automatic: the old secret retired |
| `webhook_endpoint_deleted` | `webhook_endpoint.deleted` | automatic |
| `beneficiary_removed` | `beneficiary.removed` | automatic |
| `switch_set`, `switch_cleared` | `switch.set`, `switch.tripped`; `switch.cleared` | printed for the owner's confirmation |

- **Replay.** `pnpm fin restore replay <env> --since <restore point>` reads the journal from R2 (never
  from the restored database), applies the automatic kinds through a registered `migrate --task
  journal-replay`, prints the confirmation kinds by kind and count, applies them only with
  `--confirm <kind,...>`, and records `audit.restore_replayed`. A dry run (`--dry-run`) prints what it
  would do and changes nothing; the restore check (§8.4) runs it.

### 3.11 Who sees what

ARCHITECTURE §8.6 holds: organisation scope on the organisation's Audit log (`auditLog.read`), never
showing a provider's name; person scope in Account security, "Your activity"; staff scope in Fin
Admin's Audit log (`audit.read`). Screens read through `api`'s door operations of spec 02 §14.5; nothing
else reads `audit.event`. A staff decision the organisation can see writes its staff event and a
mirror organisation event with actor `system`, `via: "admin"` and no staff ID (spec 03 SD3-11). The
context row ([BC-03]) is shown to the person and to the organisation's log only, and never to another
organisation. A scope test proves no `staff` row ever reaches an organisation's page (T08-08).

### 3.12 Retention

| Record | Kept | Then |
|---|---|---|
| `audit.event` | For the life of the service ([DA-08] default, subject to counsel); staging may be reset with a marker | never deleted in production |
| `audit.event_context` (address and user agent) | 13 months (D08-02) | deleted by `audit-context-sweep` (daily) through `audit.sweep_context()`, with a `system.sweep_completed` row |
| `audit.journal_entry`, `audit.journal_shipped` | For the life of the service | never deleted |
| R2 audit and ledger heads, journal objects | Lock one year in staging; Indefinite in production ([AU-03]) | the lifecycle rule deletes staging objects after the lock |
| `ops.privileged_login` | For the life of the service | never deleted |
| Better Stack `audit.head`, `ledger.head`, `audit.check` lines | 30 days staging, 90 days production ([OB-07]) | vendor deletes |

### 3.13 Audit outside the application

ARCHITECTURE §8.8 and spec 01 §10 hold. The R2 vault's inventory is in the Phase 0 watcher (EXECUTION §2.5
step 10, spec 01 §7.11); the other rows are additions in hardening (H-04):

| What | How | Kept in | Alert |
|---|---|---|---|
| Railway's workspace audit log | `pnpm fin railway audit-export <env>`: weekly from the operator's machine, daily from a job once a non-deploying credential exists ([AU-06]); at once in an incident | the ops bucket, `age`-encrypted | `rotation-overdue` names a late export |
| GitHub settings | The watcher hashes the ruleset, settings, environments, collaborators, deploy keys and Actions settings hourly ([AU-09]) | Better Stack lines | `github-settings-changed` |
| Cloudflare | The watcher's minute checks; the account audit log read by `pnpm fin verify` | Better Stack lines | `cloudflare-config-changed` |
| Better Stack | The daily dry run of `pnpm fin monitoring apply` reads every object and `paused_reason` ([AU-05] default) | Better Stack lines from the `ops` source | `monitoring-drift` |
| The R2 vault (Phase 0) | The watcher's inventory of every locked object: removed or changed before its lock ends pages | Better Stack lines | `vault-inventory-changed` |
| Operator SQL | `pnpm fin db` transcripts and Postgres's statement log for `fin_owner` and `fin_readonly` ([AU-08]) | the ops bucket, encrypted | `privileged-login` |

### 3.14 Duties, lines and alerts for audit

| Duty | Runs in | Cadence | Line | Heartbeat or success alert |
|---|---|---|---|---|
| `audit-sequencer` | worker (lease holder) | every second | `job.run` once a minute | `audit-unsequenced` (from the probe) |
| `audit-anchor` | worker | every minute; ledger daily 00:05 UTC | `job.run`, `audit.head`, `ledger.head` | `duty-stalled-audit-anchor` |
| `audit-check` | worker | hourly | `audit.check` | heartbeat `audit-check` |
| `journal-ship` | worker | on wake and every minute | `job.run` | `journal-unshipped` |
| `audit-context-sweep` | worker | daily | `job.run` | `duty-stalled-audit-context` |

| Alert | Sev | Fires on | Means | First check | Runbook |
|---|---|---|---|---|---|
| `audit-not-written` | P | any `audit.write_failed` | an action was refused because its event could not be written | the `sqlstate`: `FA002` is a fragment's `roles` missing a login, `FA004` a metadata shape | `audit-not-written.md` |
| `audit-guard` | P | any `database.audit_guard` | a write to a critical table came without its event: a bug, or a leaked login | the `table`; the release; `privileged-login` lines in the same minutes | `audit-guard.md` |
| `audit-unsequenced` | P | the probe's `auditUnsequencedS` above its threshold | rows are not being chained | the worker's scheduler lease; the sequencer's last `job.run` | `audit-unsequenced.md` |
| `audit-chain-broken` | P | any `audit.check_failed` with `reason` `hash`, `link` or `gap` | a row changed or vanished | the restore and reset markers; `privileged-login` history | `audit-chain-broken.md` |
| `audit-head-moved-back` | P | any `audit.head_moved_back` | the database is behind its anchors: a restore without a marker, or a failover that lost commits | `failover-detected`; the newest marker | `failover-lost-commits.md` |
| `audit-head-not-extending` | P | any `audit.head_not_extending` | the chain between two anchors does not verify | as `audit-chain-broken` | `audit-chain-broken.md` |
| `audit-anchor-failing` | P | `audit.anchor_conflict`, or no successful anchor for 10 minutes while the head moved | the outside witness is not being written | the audit R2 token's expiry; R2's status | `audit-anchor-failing.md` |
| `audit-epoch-unexpected` | P | the watcher's `audit-epochs` check | an epoch started without a marker | the ops bucket's markers; who ran `start_epoch` | `audit-chain-broken.md` |
| `audit-head-line-regressed` | P | §3.8 | Better Stack's copy shows the head going back | as `audit-head-moved-back` | `failover-lost-commits.md` |
| `journal-unshipped` | P | the oldest unshipped journal entry older than 5 minutes | a restore now could undo a revocation | the audit R2 token; the `journal-ship` duty | `journal-unshipped.md` |
| `duty-stalled-audit-anchor`, `duty-stalled-audit-context` | N | no `job.run result=ok` for three cadences | the duty stopped | the worker's lease and logs | `duty-stalled.md` |

### 3.15 Tests

| ID | Level | Statement |
|---|---|---|
| T08-01 | U | `defineEvents` and the generator refuse a duplicate name, a bad name, an unknown category, scope or role, a non-strict or nested metadata schema, and empty `roles` |
| T08-02 | I | After migrating a fresh Postgres 18, `audit.event_type` equals the compiled `AUDIT_EVENTS`; a second run changes nothing |
| T08-03 | I | `audit.record()` refuses each of `FA001` to `FA005` with its SQLSTATE; a service login cannot `INSERT`, `UPDATE` or `DELETE` any `audit` table (42501) |
| T08-04 | I | Each login role can record exactly the events whose `roles` name its group, and no other (generated per event) |
| T08-05 | I | `UPDATE` of a chained row, any `DELETE` and `TRUNCATE` are refused for every login including `fin_owner` outside the sequencer; the sequencer sets each row's chain fields once |
| T08-06 | I | Every guard registration matches an installed trigger; each guarded operation without its event fails at commit with `FA010`; with its event in `target_id` or `ref_ids` it commits |
| T08-07 | U | `recordAudit` throws on an email, IP, token shape, URL with a query or nine digits in any metadata string, and on an actor kind the event does not allow |
| T08-08 | I | No `staff` scope row is returned by `audit.organisation_log` or `audit.person_activity` |
| T08-09 | I | The TypeScript hash equals `audit.row_hash` for 10,000 generated rows, including nulls, empty arrays, Unicode metadata and every column at its maximum |
| T08-10 | I | Two hundred concurrent audited transactions commit without waiting on each other; the sequencer then chains them gaplessly; a transaction held open does not block others' commits |
| T08-11 | I | The verifier finds a changed byte in a chained row (done as the superuser in the test), a deleted row, a gap, an anchor whose hash differs, and a head behind its newest anchor, each with its line |
| T08-12 | I | An anchor PUT that meets 412 with equal content counts as written; with different content it writes `audit.anchor_conflict` |
| T08-13 | I | Each event that declares a journal kind writes its entry in the same transaction; a rolled-back action leaves neither |
| T08-14 | I | `pnpm fin restore replay --dry-run` against a restored copy lists every automatic and confirmation entry newer than the restore point; a real run re-revokes a key that the restore brought back |
| T08-15 | I | `audit.start_epoch` links the new epoch's first row to `p_prev_hash`; the verifier accepts a marked epoch and the watcher's check refuses an unmarked one |
| T08-16 | U | Every event in `AUDIT_EVENTS` has at least one test whose title names it and which fails when the event is not written (a check reads the test titles, the AGENTS rule) |

---

## 4. Security emails (R3, R9)

### 4.1 Rules

People are told when access changes ([AU-07], ARCHITECTURE §8.7). The rules of ARCHITECTURE §7.5 and
§9.4 and spec 02 §17.1 hold; this section fixes the classes every template declares and the digest
that keeps a security notice from ever being dropped.

- A template is declared in `packages/email/src/templates/<area>/<name>.ts` with
  `defineTemplate({ name, area, class, subdomain, secretBearing, bypassLimits, params })` from
  `packages/email/src/classes.ts`. `params` is a strict Zod object of IDs plus the display values the
  template names (`code`, `orgName`, `roleLabel`, `personName`, `device`, `time`, `count`, `mode`,
  `rail`, `accountLast4`); the worker resolves names and addresses at send time, never the caller.
- Every template is queued with `email.enqueue()` in the action's own transaction. A failure to queue
  rolls the action back, so an action that mints a credential is refused when its notice cannot be
  queued ([SA-41]). Only `worker` sends ([EM-04]).
- **The never-dropped rule.** A `security` row is never deleted unsent: past its recipient's
  allowance it is folded into a digest that is still sent (§4.3); if the send fails for good or the
  recipient is suppressed, `email.security_unsent` is written (`template`, `reason`: `suppressed`,
  `failed`, `budget`, `invalid_recipient`) and `security-email-unsent` pages.
- Lean layout, Fin's own words, at most one link, no image; typed values only in labelled boxes in the
  body, escaped, never in a subject, heading or preview; `Auto-Submitted: auto-generated`, a new
  `X-Entity-Ref-ID`, `X-Fin-Category` with the class; no `List-Unsubscribe` (ARCHITECTURE §9.3, §9.6).
- No template carries an enrolment code, an API key secret, a backup code, a webhook secret, or a link
  token other than the invitation's and the hosted links' (T08-23).

### 4.2 Classes

| Class | Sending subdomain | What it carries | Priority in the outbox | Past the recipient's allowance | Secret-bearing |
|---|---|---|---|---|---|
| `code` | `auth.<zone>` | a one-time code or a sign-in link | 1 | the asking endpoint refuses with its same answer; never digested | yes: the row is deleted on send and left out of dumps |
| `security` | `auth.<zone>` | a change to someone's access, sign-in methods, keys, team, organisation or money recipients | 2 | folded into the hourly digest (§4.3), unless the template bypasses limits | no |
| `notice` | `notify.<zone>` | invitations and operational mail to developers | 3 | the action answers 429 `rate_limited` | invitations yes |
| `customer` | `notify.<zone>` | white-labelled mail to a developer's customers and people | 3 | the action answers 429; in Sandbox the Sandbox rule applies first ([SA-40], spec 03 §17.2) | links yes |
| `ops` | `auth.<zone>` | the delivery check (spec 01 S0-09) | 4 | not limited per recipient | no |

### 4.3 The digest

- **The allowance.** A `security` template counts against its recipient's security allowance: 5 an
  hour per recipient, keyed by `FIN_LIMIT_KEY_<n>`'s HMAC of the normalised address ([SA-41]). The
  sender (`worker`, which holds the limit key and resolves every recipient) counts at claim time, in
  the logged table `email.recipient_window`, so a restart never resets it ([DA-16]). The allowance
  `email.enqueue()` counts at queue time for codes (ARCHITECTURE §9.4) is a separate one.
- **Bypass.** Templates with `bypassLimits: true` are always sent on their own and still count: a
  Production key's change (`api-keys/key-changed` with `mode: "live"`), `money/beneficiary-added`,
  every `orgs/member-*` template, `orgs/role-permissions-changed`, `staff/staff-access-changed`,
  `staff/staff-factors-reset` and `staff/staff-switch-changed`.
- **Folding.** When the sender claims the sixth or a later `security` row for one recipient within
  the hour, it sets `folded_into = 'dig_<recipient hash>_<hour>'` on it and does not send it alone. At the end of the hour (or
  10 minutes after the first fold, whichever is sooner) the sender sends one `ops/security-digest`
  to that recipient: "There were {count} changes to your Fin account or team in the last hour." with
  one fixed line per template kind and its count, in Fin's words only, and one link to the right
  activity page. Then it deletes the folded rows. A digest is never folded.
- **Lines.** `email.folded` (`template`, `digestKey`) and `email.sent` with `template:
  "ops/security-digest"` and `folded` (count).

### 4.4 The catalogue across every area

Templates live in `packages/email/src/templates/<folder>/`, owned by the lane named. The trigger and
copy are in the spec named. **This table is the canonical list of template names and folders
(D08-33)**: `email.enqueue()`'s allowlist and T08-20 to T08-23 are built against it, specs 02 to 05
use its names, and a change to a name or folder is made here and in the area spec together, as for
§3.4. A folder has one owning lane.

| Template | Folder (lane) | Spec | Class | To | Bypass |
|---|---|---|---|---|---|
| `sign-in-code` | `identity/` (L-SAT-02) | 02 §17.2 | code | the address | |
| `confirm-email` | `identity/` | 02 §17.2 | code | the address | |
| `already-registered` | `identity/` | 02 §17.2 | security | the address | |
| `new-sign-in` | `identity/` | 02 §17.2 | security | the person | |
| `sign-in-methods-changed` | `identity/` | 02 §17.2 | security | the person | |
| `account-locked` | `identity/` | 02 §17.2 | security | the person (once a day) | |
| `session-ended` | `identity/` | 02 §17.2 | security | the person | |
| `password-paused` (stretch) | `identity/` | 02 §5.7 | security | the address's owner (once a day) | |
| `reset-password` (stretch) | `identity/` | 02 §5.7 | code | the address | |
| `account-recovery-started`, `account-recovery-finished` | `identity/` | 02 §6.8 | security | the person, the recovering organisation's Super admins, and the Super admins of every organisation where the person holds a privileged role | |
| `invitation` | `orgs/` (L-SAT-03) | 02 §17.2 | notice | the invited address | |
| `member-joined` | `orgs/` | 02 §17.2 | security | the inviter and every Super admin | yes |
| `member-removed` | `orgs/` | 02 §17.2 | security | the person; the remaining Super admins and Admins | yes |
| `member-role-changed` | `orgs/` | 02 §17.2 | security | the person and every Super admin | yes |
| `role-permissions-changed` | `orgs/` | 02 §17.2 | security | the role's holders | yes |
| `organization-deleted` | `orgs/` | 02 §17.2 | security | every member | |
| `key-changed` (one template for created, edited, rolled and revoked) | `api-keys/` (L-SAT-11) | 05 §4.10 | security | every member | for `mode: "live"` |
| `key-exposed` | `api-keys/` | 05 §4.10 | security | Super admins and Admins | yes |
| `endpoint-changed` | `webhooks/` (L-SUN-04) | 05 §5.7 | security | Super admins and Admins | |
| `endpoint-paused` | `webhooks/` | 05 §5.7 | notice | Super admins and Admins | |
| `verification-link` | `kyc/` (L-SUN-02) | 03 §17.1 | customer | the customer's address on record | |
| `person-link` | `kyc/` | 03 §17.1 | customer | a business's person | |
| `rfi-opened` (stretch), `rfi-changed`, `rfi-cancelled` | `kyc/` | 03 §17.1 | customer | a live customer | |
| `company-email-code` | `golive/` (L-SUN-02) | 03 §17.1 | code | the typed company address | |
| `person-link` | `golive/` | 03 §17.1 | customer | a go-live person | |
| `decided` | `golive/` | 03 §17.1 | security | every Super admin | |
| `paused`, `restored` | `golive/` | 03 §17.1 | security | every Super admin | |
| `staff-sign-in-code` | `staff/` (L-SAT-04) | 02 §17.3 | code | the address | |
| `staff-new-sign-in` | `staff/` | 02 §17.3 | security | the member | |
| `staff-sign-in-methods-changed` | `staff/` | 02 §17.3 | security | the member | |
| `staff-factor-enrolled` | `staff/` | 02 §17.3 | security | every Admin | |
| `staff-access-changed` | `staff/` | 02 §17.3 | security | the person and every Admin | yes |
| `staff-factors-reset` | `staff/` | 02 §17.3 | security | the person and every Admin | yes |
| `staff-role-permissions-changed` (stretch) | `staff/` | 02 §17.3 | security | its holders and every Admin | |
| `staff-switch-changed` | `staff/` | 02 §17.3 | security | every Admin | yes |
| `reveal-budget` | `staff-kyc/` (L-SUN-08) | 03 §17.1 | security | every Admin | |
| `beneficiary-added` | `money/` (L-MON-01) | 04 §29.2 | security | Super admins and Admins | yes |
| `delivery-check` | `ops/` (L-SAT-05) | spec 01 S0-09 | ops | the seed inbox | |
| `security-digest` | `ops/` (L-SAT-05) | §4.3 | security | the folded rows' recipient | |

`email.enqueue()`'s per-role allowlist ([DA-14]) is generated from the folders: `fin_console` the
`identity/`, `orgs/` and `api-keys/` templates; `fin_admin` the `staff/` templates; `fin_api` the
`kyc/`, `golive/`, `webhooks/`, `api-keys/key-exposed` and `staff-kyc/reveal-budget` templates;
`fin_payments` the `money/` templates; `fin_worker` the `webhooks/endpoint-paused` template and the
`ops/` templates. A refusal test per role and folder (T08-22).

### 4.5 Tests

| ID | Level | Statement |
|---|---|---|
| T08-20 | U | Every template renders with sample parameters; no typed value appears in a subject, heading or preview; every header is in Cloudflare's allowlist; each class sets its subdomain |
| T08-21 | I | Six `security` notices to one address within an hour: five are sent alone, the sixth is folded and one `ops/security-digest` arrives with the right counts; a bypass template is never folded; a restart in the middle keeps the count |
| T08-22 | I | `email.enqueue()` refuses every template outside each role's folders, with its own SQLSTATE |
| T08-23 | U | No template's `params` schema accepts a key, secret, backup code or enrolment code shape (the scrubber's shapes run over sample values) |
| T08-24 | I | An action whose notice cannot be queued (the function made to fail) rolls back and writes nothing |
| T08-25 | I | A suppressed recipient of a `security` template writes `email.security_unsent` with `reason: "suppressed"` |

---

## 5. Personal data

### 5.1 Classes

| Class | What | Examples | May appear in |
|---|---|---|---|
| PD-0 | Fin's own IDs and statuses | `cus_`, `org_`, statuses, reason codes, counts, amounts in minor units | everywhere, including lines and audit metadata |
| PD-1 | Derived values that identify no one without a key | keyed hashes, masks (`a•••@gmail.com`), the blind index, fingerprints | Postgres; screens (masks only) |
| PD-2 | Personal data Fin holds sealed | a customer's or person's display name; Sandbox details; go-live answers; bank account numbers and holder names | Postgres, sealed (`fdk<n>.`); in memory while opened; in a screen after a fresh factor |
| PD-3 | Personal data Fin never stores | identity documents, selfies, live customers' details | Sumsub only; passed through in memory once per request (ARCHITECTURE §6.5) |
| PD-4 | Personal data about developers and staff | email addresses, names, client addresses and user agents on audit context rows | Postgres in clear for sign-in; `audit.event_context` for 13 months |
| S | Secrets | §6 | sealed Railway variables or sealed columns only |

### 5.2 Where personal data sits

The privacy notice (PG-07) lists every row of this table. `docs/security/personal-data.json` holds it
in a form `threat-model:check` reads: every column whose name ends in `_sealed` in any migration, and
every table this table names, must have a row, or the check fails (D08-08).

| Place | What | Class | Kept | Erasure |
|---|---|---|---|---|
| Sumsub | Live customers' and people's details, documents, selfies, review results | PD-3 | Sumsub's retention | Fin deactivates every applicant; Sumsub purges; its webhooks set `erased_at` (ARCHITECTURE §6.9) |
| `kyc.customer`, `kyc.person` | Sealed display name, keyed hashes, masks, the name index, `fields_present` | PD-1, PD-2 | until erasure | blanked at once; tombstone of IDs kept |
| `kyc.applicant_write` | Sealed values in transit to Sumsub | PD-2 | until Sumsub accepts, or purged on a permanent 4xx | deleted with the subject |
| Sandbox customers | Sealed details (made-up data only by the Sandbox rule) | PD-2 | 90 days after the last change | deleted by `sandbox-purge` |
| `money.beneficiary`, `money.virtual_account` | Sealed account number and holder name | PD-2 | 5 years after the relationship ends ([DA-08]) | personal fields blanked; IDs and amounts kept |
| `identity`, `staff` | Developers' and staff members' addresses and names | PD-4 | while the account exists | deleted with the account; audit keeps IDs |
| `audit.event_context` | Client address and user agent of console and Fin Admin actions ([BC-03]) | PD-4 | 13 months (D08-02) | swept |
| `email.outbox` | Recipient address and parameters while queued | PD-4 | until sent; code rows deleted on send | left out of dumps ([DA-15]) |
| Cloudflare Email Sending | Recipient addresses in the activity log; message bodies only if preview were on (it is off, [EM-06]) | PD-4 | about 31 days | vendor deletes |
| Better Stack | Nothing personal by rule; the scrubbers and VRL are the controls | PD-0 | 30 or 90 days | vendor deletes |
| Cloudflare Logpush | The allowlisted fields of §7.12 only; no client address, query string, cookie or user agent | PD-0 | Better Stack's retention | vendor deletes |
| Railway PITR, volume backups | Everything in Postgres | all | about 4 weeks; snapshots up to 89 days | expires; the restore re-applies erasures from the journal |
| R2 dumps | Everything in Postgres except sessions, proofs, outbox and limits, `age`-encrypted | all | nightly 70 days, hourly 7 days | expires; the restore re-applies erasures |
| MassPay | A holder's details shared through `api`'s holder door | PD-2 | MassPay's retention | MassPay's terms; [MO-12]'s consent step names it |
| The private overlay, Cloudflare Access | Staff addresses | PD-4 | while staff | removed with the staff member |

### 5.3 Where personal data never goes

| Never in | Enforced by | Test |
|---|---|---|
| A log line (Railway stdout or Better Stack) | `scrubLine` before stdout and before shipping; withheld field names; VRL second net | T08-30, AC-P0-12 |
| An error report, front or back | `scrubEvent`, `scrubBreadcrumb`; `sendDefaultPii: false`; the envelope relay re-scrubs | T08-32 |
| An audit row's metadata | the strict schema and `assertNoPersonalShapes` in `recordAudit` | T08-07 |
| A developer event or webhook body | thin payloads (IDs and statuses); the reverse-coverage test of ARCHITECTURE §6.5 | spec 05 §13 |
| A URL (path or query) | the link token posted in a body; codes in fragments; search by POST; Logpush redaction of verify, selfie and invitation paths | spec 03 §19, spec 05 §13 |
| A metric label | `monitoring:check` refuses an ID-shaped or free-text label (MC-06) | T08-36 |
| An email subject, heading or preview | template rendering test | T08-20 |
| The browser's storage | `localStorage` holds only `fin-theme` and `fin-sidebar` ([UI-13], spec 06 S6-04) | spec 05 T05-45 for Try it |
| A cache | `Cache-Control: no-store` on every API answer; reads of Sumsub never cached | spec 03 §19 |

### 5.4 The scrubbers

`packages/core/src/scrub.ts` (P0-D) exports `scrubLine(line)`, `scrubEvent(event)`,
`scrubBreadcrumb(breadcrumb)`, `scrubText(text)` and `assertNoPersonalShapes(value)`;
`packages/core/src/safe-error.ts` exports `safeError(error)`, which keeps the error's class name, a
bounded code and the stack frames' file and line numbers, and drops the message unless the error is a
`FinError` with a fixed message. Nothing thrown is logged whole.

**Withheld fields.** In any object, at any depth, a key that matches one of these names
(case-insensitive, ignoring `_` and `-`) has its value replaced with `"[withheld]"`: `name`,
`firstname`, `lastname`, `fullname`, `displayname`, `holdername`, `email`, `emailaddress`, `phone`,
`address`, `street`, `postcode`, `zip`, `dob`, `dateofbirth`, `ip`, `ipaddress`, `clientip`,
`useragent`, `password`, `secret`, `token`, `code`, `otp`, `cookie`, `authorization`, `apikey`,
`key`, `accountnumber`, `iban`, `taxid`, `ssn`, `note`, `message`, `body`, `query`, `querystring`,
`url`, `headers`, `details`, `answers`. A key ending in `Id` (for example `keyId`, `orgId`) is kept.

**Shapes.** In every string value, after the field rule, each pattern is replaced with its token.
The patterns live in `packages/core/src/scrub-shapes.ts`, one constant each, and the public-safety
check and gitleaks configuration import the same list. Every pattern uses the `gu` flags; those
marked (i) add `i`.

| Shape | Pattern (JavaScript) | Token |
|---|---|---|
| Fin API key | `fin_(test\|live)_(sk\|rk)_[0-9A-Z]{10}[0-9A-Za-z]{38}` | `[api-key]` |
| Webhook secret | `whsec_[A-Za-z0-9+/=_-]{24,}` | `[secret]` |
| Bearer header value | `bearer\s+[A-Za-z0-9._~+/=-]{8,}` (i) | `Bearer [secret]` |
| JWT, Access token, tunnel token (base64 JSON) | `eyJ[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{4,}){0,2}` | `[token]` |
| Cloudflare account token | `cfat_[A-Za-z0-9_-]{20,}` | `[token]` |
| Better Stack heartbeat or incoming webhook URL | `https://[a-z0-9.-]*betterstack[a-z0-9.-]*\.com/api/v[0-9]+/(heartbeat\|incoming-webhook)/[A-Za-z0-9]+` | `[heartbeat-url]` |
| A DSN | `https://[A-Za-z0-9]+@[A-Za-z0-9.-]+/[0-9A-Za-z]+` | `[dsn]` |
| Private key block | `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` | `[private-key]` |
| `age` identity | `AGE-SECRET-KEY-1[0-9A-Z]{58}` | `[private-key]` |
| Postgres URL with a password | `postgres(ql)?://[^:/\s]+:[^@\s]+@` | `postgres://[login]:[secret]@` |
| Cookie pair | `__(Host\|Secure)-[A-Za-z0-9._-]+=[^;\s]+` | `[cookie]` |
| Ingress proof header | `fin-ingress-proof:\s*\S+` (i) | `Fin-Ingress-Proof: [secret]` |
| Email address | `[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}` | `[email]` |
| IPv4 address | `\b(?:\d{1,3}\.){3}\d{1,3}\b` | `[ip]` |
| IPv6 address | `\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b` (and `::` forms) | `[ip]` |
| A query string | `\?[^\s"'#]*` | `?[query]` |
| An ID-bearing or token-bearing path segment | `/(c\|p\|a\|s\|i)/[A-Za-z0-9_-]{16,}` and any segment of 24 or more base64url characters | `/[segment]` |
| A run of nine or more digits | `\b\d{9,}\b` | `[digits]` |
| A six to eight digit code beside `code`, `otp` or `pin` | `(code\|otp\|pin)\W{0,3}\d{6,8}` (i) | `$1 [code]` |

Sumsub and MassPay credential shapes join the list when SP-11 and SP-13 record them (UNVERIFIED).
Numbers (as JSON numbers) are never scrubbed, so `durationMs` and amounts survive. The test
(`scrub.test.ts`, T08-30) has one case per row and one per withheld name, and a property test that
plants every shape in random lines and nested objects and finds none after scrubbing.

### 5.5 Better Stack's second net

Each source and Errors application gets a VRL transformation, applied by `pnpm fin monitoring apply`
from `ops/monitoring/vrl/logs.vrl` and `ops/monitoring/vrl/errors.vrl`. It deletes the withheld field
names at the top level and one level down, and replaces the email, IP and key shapes in `message`.
Because a failing VRL keeps the event unmodified (research B4 §3.6), Fin's own scrubbers run first,
always; VRL is never the control.

### 5.6 Reads of personal data

ARCHITECTURE §6.5 and spec 03 §8.1 hold: five places only, once per request, never cached, each a
`kyc.pd_read` line and, where a person sees it, an audit row; 300 reads per 10 minutes per
organisation; staff reveal budgets per hour and per day ([SA-39], `FIN_STAFF_REVEAL_BUDGET_HOUR`,
`FIN_STAFF_REVEAL_BUDGET_DAY`). Alerts: `reveal-budget-reached` (N), and `pd-read-limit` (N, D08-09),
when an organisation meets its 300-read limit, which is how a compromised console session harvesting
details would look.

### 5.7 Erasure

ARCHITECTURE §6.9 and spec 03 §7.5 hold; H-09 finishes it. This spec adds:

- `customer.erased` is written when Sumsub's deletion webhooks have arrived for every applicant of
  every attempt; until then the erasure request stays `waiting_provider`, and one older than 30 days
  raises `erasure-failing` (P).
- The residues erasure cannot reach at once are the rows of §5.2 marked "expires", listed in the
  privacy notice with their expiry.
- A restore re-applies every `customer_erased` journal entry newer than the restore point before
  serving (§3.10).

### 5.8 Requests from people about their data

Not built at launch. A request that reaches Fin is handled by the owner by hand, with counsel, under
[DA-08]; Fin's part for a live customer is to point to the developer (Fin is likely the processor) and
to Sumsub. Recorded as an open item for counsel (§15).

---

## 6. Secrets and the key hierarchy

### 6.1 The hierarchy

| Level | What | Held | Lifetime |
|---|---|---|---|
| L0, roots | The escrow `age` identity per environment ([DA-10]: staging's will be in the owner's password manager with a printed copy once the owner gives its recipient, CR-10; until then staging has no escrow ([BD-14]); production on two hardware keys and a sealed printed copy); the owner's logins to GitHub, each Cloudflare account (staging, production, vault, watch), Railway, Better Stack, Sumsub, MassPay and the identity provider, each with security keys; from hardening (D6), the receipt-signing private keys in each machine's `fin-review` keychain; until hardening (D6) the agents' sessions on both machines also work with the owner's GitHub login (ARCHITECTURE §7.8, §11.1; TM-L15) | offline, or the owner's own devices; never online at Fin | years; rotated on suspicion |
| L1, operator credentials | The Railway project token, the Cloudflare operator token, the static deploy token, the Better Stack team tokens, the R2 bucket-administration token, the watcher's read-only tokens, the builder account's tokens (from hardening, D6) | minted short-lived and typed into the secure prompt per run; never stored by Fin. Exceptions: until the owner is back, the staging operator credentials the owner gave at the secure prompt at about 08:37 on 21 Nov, and the operator's writer tokens for the vault's ops and state buckets minted from them (CR-15), each in an owner-only file on the build machine, outside every repository, never printed and never in CI, and read by `pnpm fin` per run ([SA-22], ARCHITECTURE §7.8, TM-L16); staging's Railway project token, static deploy token and Better Stack Telemetry token in protected GitHub environments ([CI-03]), once those exist, when the owner is back ([BD-05]); the watcher's read-only tokens in the watcher's own secrets | 24 hours (Cloudflare operator; the staging token given on 21 Nov expires on Thu 26 Nov, and the owner renews it before then) to 90 days |
| L2, service secrets | Every family of §6.2 held by a service | sealed Railway variables on the one service that needs each, escrowed first (on staging once CR-10 is given; until then not escrowed and regenerated if lost, [BD-14]) | per §6.2 |
| L3, derived keys | HKDF-SHA256 subkeys of the seal and index keys, per organisation and use (ARCHITECTURE §6.6) | computed in memory per call; never stored | as their parent |
| L4, data secrets | Webhook endpoint secrets (sealed under the seal key in `events`); TOTP secrets and backup codes (encrypted under `BETTER_AUTH_SECRETS`); API key hashes (HMAC under the pepper); enrolment codes and one-time codes (hashed) | Postgres columns; on staging only, the first staff admin's two TOTP secrets, Fin Admin's and Access's own factor, are also held in local secret files on the build machine, outside every repository, never printed or logged and never in CI ([SA-04], [FD-05], TM-L14); in production no agent holds any staff member's factor | per object |

**One rule for every L2 family** ([SA-22], ARCHITECTURE §4.9, §7.8): generate with `pnpm fin` (32
random bytes from `crypto.randomBytes` unless the issuer makes it), encrypt to every escrow recipient,
upload `escrow/<family>/<environment>-<version>.age` write-once to `fin-next-<env>-escrow`, hand the
ciphertext to the owner's password manager, and only then set the sealed variable. Rotation follows
"escrow first, then Railway, then verify, then revoke the old value". No secret appears in the
repository, an image, a static build, a build argument, a log, an event, an error report, a pull
request or a workflow log (NB-08). On staging the escrow steps wait for CR-10 ([BD-14]). Until the
owner gives the staging recipient, a staging value is generated and set as a sealed variable with no
escrow copy, and is regenerated if lost.

**Versioned families.** A family that keeps more than one version is written `<FAMILY>_<n>` with
`<FAMILY>_IN_USE=<n>`. Readers accept every version present; writers use `IN_USE`; a boot with
`IN_USE` naming an absent version exits 78; at most three versions are present at once.

### 6.2 The families

Purpose and holders follow ARCHITECTURE §7.8; this table adds the exact variables, the form and the
runbook. "Deploys" counts the Railway deploys one routine rotation needs.

| Family | Variables | Held by | Form | Cadence | Runbook (`docs/runbooks/`) | Deploys |
|---|---|---|---|---|---|---|
| `tunnel-token` | `TUNNEL_TOKEN` | `cloudflared-public`, `cloudflared-public-b`, `cloudflared-admin`, `cloudflared-admin-b`, `cloudflared-db`: each its own | issued by Cloudflare for the tunnel | 90 days, and at once after any Railway or Cloudflare notice ([FD-12]) | `evict-tunnel.md` (§8.2) | scale changes only |
| `ingress-proof` | `FIN_INGRESS_PROOFS` | edge, console, admin, verify: each its own host roles | JSON, host role to `[current, previous]`, each 32 bytes base64url | 90 days | `rotate-ingress-proof.md` | 2 per service |
| `caller-key` | `FIN_CALLER_KEY_<n>` (private); `FIN_CALLER_PUBLIC_KEYS` (callees, not secret) | edge, console, admin, verify, api, payments: each its own | Ed25519 PKCS#8, base64 | 90 days | `rotate-caller-keys.md` | 3 |
| `seal-key` | `FIN_SEAL_KEY_<n>`, `FIN_SEAL_KEY_IN_USE` | api, worker | 32 bytes base64url | yearly, or on suspicion | `rotate-seal-key.md` | 3, plus the re-seal task |
| `index-key` | `FIN_INDEX_KEY_<n>`, `FIN_INDEX_KEY_IN_USE`, `FIN_INDEX_KEY_WRITE` | api, worker | 32 bytes | yearly, or on suspicion | `rotate-index-key.md` | 3, plus the re-index task |
| `money-seal-key` | `FIN_MONEY_SEAL_KEY_<n>`, `FIN_MONEY_SEAL_KEY_IN_USE` | payments | 32 bytes | yearly | `rotate-seal-key.md` (money section) | 3 |
| `money-index-key` | `FIN_MONEY_INDEX_KEY_<n>`, `FIN_MONEY_INDEX_KEY_IN_USE`, `FIN_MONEY_INDEX_KEY_WRITE` | payments | 32 bytes | yearly | `rotate-index-key.md` (money section) | 3 |
| `limit-key` | `FIN_LIMIT_KEY_<n>`, `FIN_LIMIT_KEY_IN_USE` | console, admin, api, worker | 32 bytes | yearly | `rotate-limit-key.md` | 2 |
| `cursor-key` | `FIN_CURSOR_KEY_<n>`, `FIN_CURSOR_KEY_IN_USE` | api, payments | 32 bytes | yearly | `rotate-cursor-key.md` | 2 |
| `api-key-pepper` | `API_KEY_PEPPER_<n>`, `API_KEY_PEPPER_IN_USE` | edge, console, worker | 32 bytes | yearly | `rotate-pepper.md` | 3, plus `keys.rehash` |
| `better-auth-secrets` | `BETTER_AUTH_SECRETS` (developer realm; staff realm its own) | console; admin | JSON array, newest first, each 32 bytes | yearly, or on suspicion | `rotate-better-auth-secrets.md` | 2, plus the re-encrypt task |
| `sumsub-token` | `SUMSUB_APP_TOKEN_{WRITE,READ,DOCUMENTS,WORKER}`, `SUMSUB_SECRET_KEY_{...}` | api (write, read, documents), worker (worker) | issued by Sumsub | 180 days ([KY-04]) | `rotate-sumsub.md` | 1 per holder |
| `sumsub-webhook-secret` | `SUMSUB_WEBHOOK_SECRETS` | api | JSON array of active secrets | 180 days | `rotate-sumsub.md` (webhook section) | 2 |
| `masspay-key` | `MASSPAY_API_KEY` | payments | issued by MassPay | 180 days, or MassPay's terms | `rotate-masspay.md` (spec 04 §18.3) | 1 or 2 (SP-13) |
| `masspay-webhook-secret` | `MASSPAY_WEBHOOK_SECRETS` | payments | JSON array | 180 days | `rotate-masspay.md` | 2 |
| `email-token` | `FIN_EMAIL_TOKEN` | worker | Cloudflare `cfat_` token, Email Sending Edit (Cloudflare's token page names this group Email Sending Write: [BD-28]; `docs/plan/spikes.md`, run 5), IP-filtered | 180 days or less | `rotate-email-token.md` | 1 |
| `vault-token` | `FIN_VAULT_AUDIT_*` (worker), `FIN_VAULT_BACKUPS_*` (backup) | as named | R2 token scoped to one bucket | 180 days, staggered | `rotate-r2.md` | 1 |
| `telemetry-token` | `FIN_TELEMETRY_TOKEN` | every Fin service, its own source | issued by Better Stack | on suspicion | `rotate-betterstack.md` | 1 |
| `errors-dsn` | `FIN_ERRORS_DSN` (server), `FIN_BROWSER_ERRORS_DSN` (each app's API service, for its relay) | each service its own | issued by Better Stack | on suspicion | `rotate-betterstack.md` | 1 |
| `heartbeat-url` | `FIN_HEARTBEAT_<NAME>_URL` | the one process that pings | issued by Better Stack | on suspicion | `rotate-betterstack.md` (heartbeat section) | 1 |
| `db-login` | `FIN_DB_USER`, `FIN_DB_PASSWORD` | each service with a login, its own | SCRAM verifier set by a registered task; 32 bytes base64url | 180 days | `rotate-db-login.md` | 1, then disable the old login |
| `turnstile-secret` (if adopted) | `FIN_TURNSTILE_SECRET` | console, admin, verify | issued by Cloudflare | yearly | `rotate-turnstile.md` | 1 |
| `google-client-secret` (if built) | `FIN_GOOGLE_CLIENT_SECRET` | console (admin if enabled) | issued by Google | yearly | `rotate-google.md` | 1 |
| `static-deploy-token` | `CF_STATIC_DEPLOY_TOKEN` | the `staging-static` GitHub environment, once it exists, when the owner is back ([BD-05]); until then it is not minted, and each staging upload uses a one-run static token (spec 01 §6.9); production's depends on the owner's open answer to [FD-19]: at the secure prompt only under the default put to the owner (the operator's launcher), or a `production` GitHub environment under the other answer | Cloudflare token, Workers Scripts Edit only | 90 days | `rotate-static-deploy-token.md` | none |
| `railway-project-token` | `RAILWAY_TOKEN` | the `staging` GitHub environment, once it exists, when the owner is back ([BD-05]), and until then an owner-only file on the build machine (§6.1, L1); production's at the secure prompt only | issued by Railway | 90 days | `rotate-railway-token.md` | none |
| `betterstack-ci-token` | `BETTERSTACK_TELEMETRY_TOKEN` | the `staging` GitHub environment, once it exists, when the owner is back ([BD-05]), and until then an owner-only file on the build machine (§6.1, L1) | team Telemetry token | 90 days | `rotate-betterstack.md` (CI section) | none |
| `watcher-tokens` | the watcher's secrets (CR-18) | the watcher | read-only tokens | yearly | `rotate-watcher-tokens.md` | a watcher upload |
| `receipt-signing-key` (from hardening, D6) | the `fin-review` keychain; public half in `docs/review/receipt-keys/` | each machine | Ed25519 | yearly, or on suspicion | `rotate-receipt-key.md` | none (a control-path pull request) |
| `canary-key` | Better Stack monitor secret of `api-canary` | Better Stack | a restricted Sandbox Fin key | 90 days | `rotate-canary-key.md` | none |
| `monitor-header` | Better Stack monitors' secret header; the WAF skip rule (production only: the shared staging zone has no custom rule left for it, §8.6) | Better Stack, Cloudflare | 32 bytes | yearly | `rotate-monitor-header.md` | none |
| `postgres-superuser` | the template's variables | the database service | Railway's Regenerate only ([P-18]) | on suspicion | `rotate-superuser.md` | Railway's own |
| `escrow-recipient` | `age` recipients in the public settings (staging's once the owner gives it, CR-10, [BD-14]) | the settings file | `age` X25519 | on suspicion; the drill recipient after each drill ([DA-15]) | `rotate-escrow-recipient.md` | none |

Webhook endpoint secrets are rolled by developers, and by Fin when a member who saw one leaves
([SA-33]); they are not an operator family. `fin_owner` has no standing password: each registered run
sets one with `VALID UNTIL` its end ([AU-08]).

### 6.3 Commands

All in `ops/fin` (Node built-ins only), each a registered run that prints its plan before changing
anything:

| Command | Does |
|---|---|
| `pnpm fin secret generate <env> <family> [--service <name>]` | the escrow-first order of §6.1 for one new value |
| `pnpm fin rotate <env> <family> [--holder <service>] [--emergency]` | the family's steps of §6.4 in order, pausing where a step must be confirmed; `--emergency` drops the overlap where §6.4 allows and accepts the outage it names |
| `pnpm fin reseal <env> --family seal\|money-seal --from <n>` | a one-off Railway task on the holder's image that re-seals `fdk<n>.` values in batches of 500, writing `reseal.batch` lines, until none remain |
| `pnpm fin reindex <env> --family index\|money-index --to <n>` | a one-off task that writes the new index version beside the old, then reports the count left |
| `pnpm fin task <env> auth-reencrypt --realm developer\|staff` | re-encrypts two-factor secrets and backup codes under the newest Better Auth secret |
| `pnpm fin escrow open <env> <family> <version> --reason "<text>"` | break-glass: registers the run, opens an incident (production pages `escrow-opened`), writes the encrypted record, then decrypts only into a one-off task or one `pnpm fin db` run; records `operator.escrow_opened` |

Every run ends with `operator.credential_rotated` (§3.4) and a prepared change to `ops/credentials.json`
on a branch `ops/rotate-<family>-<yyyymmdd>`, merged by a reviewed pull request (D08-10).

### 6.4 Rotation runbooks

Every runbook file has these headings, checked by `monitoring:check` (MC-10): **When**, **Who and
what they need**, **Steps** (numbered; each with its command, the result to expect and a time
target), **Verify**, **Roll back**, **If Railway is down**, **Records**, **Alerts**. The steps below
are what each file says.

| Family | Steps | Verify | Roll back | If Railway is down |
|---|---|---|---|---|
| `tunnel-token` | the blue and green swap, §8.2 steps 4 to 7 | the watcher's connector check on the new tunnel; `/api/health` on every host | swap the CNAMEs back while the old tunnel exists | delete the tunnel at Cloudflare (outage) and wait |
| `ingress-proof` | 1. generate v(n+1); 2. set `FIN_INGRESS_PROOFS` to `[new, current]` on each API service and deploy; 3. `pnpm fin rules apply <env>` switches each host's Transform Rule to the new value; 4. watch 10 minutes; 5. set `[new]` alone and deploy | no `ingress.untrusted_peer` lines; the monitors green | switch the rule back while both are accepted | do not switch the rule; nothing can reach Railway's variables |
| `caller-key` | 1. generate the caller's pair n+1; 2. add the public key to `FIN_CALLER_PUBLIC_KEYS` on every callee and deploy them; 3. set `FIN_CALLER_KEY_<n+1>`, remove `<n>`, deploy the caller (it signs with the highest version it holds); 4. after 24 hours remove the old public key from callees and deploy | no `caller.signature_invalid` lines | redeploy the caller with `<n>` while callees accept both | no change possible; the old key keeps working |
| `seal-key` | 1. add `FIN_SEAL_KEY_<n+1>` to api and worker, `IN_USE` still n, deploy both; 2. set `IN_USE=<n+1>`, deploy both; 3. `pnpm fin reseal` until zero; 4. remove `<n>` from Railway (it stays in escrow at least 89 days, the longest backup retention); 5. the next restore drill opens a pre-rotation dump with `<n>` from escrow | `reseal.batch` reaches `remaining: 0`; a "Show details" in Sandbox opens | keep `<n>` present and set `IN_USE` back | values stay sealed under `<n>`; continue when it returns |
| `index-key` | 1. add `<n+1>`, set `FIN_INDEX_KEY_WRITE=<n>,<n+1>`, deploy; 2. `pnpm fin reindex` until zero left; 3. set `IN_USE=<n+1>` (search uses it), deploy; 4. set `WRITE=<n+1>`, remove `<n>`, deploy | a search by email, phone and name finds known Sandbox customers | set `IN_USE` back while both are written | wait |
| `limit-key` | 1. add `<n+1>`; for 24 hours the limiter counts under both and enforces the higher (D08-11); 2. set `IN_USE`, deploy; 3. after 24 hours remove `<n>`, deploy | limit tests on staging | set `IN_USE` back | wait |
| `cursor-key` | set `<n+1>` and `IN_USE`, deploy; old cursors answer 400 `invalid_cursor` | a paged list | redeploy with `<n>` | wait |
| `api-key-pepper` | 1. add `API_KEY_PEPPER_<n+1>` to edge, console and worker, deploy; 2. set `IN_USE=<n+1>` (new keys), deploy; 3. `keys.rehash` applies the new pepper over each stored hash and records its version; 4. when `keys-not-rehashed` is clear, remove `<n>` from Railway | the canary key still works; `keys-not-rehashed` clear | keep `<n>` present | the edge keeps verifying with what it holds |
| `better-auth-secrets` | 1. prepend a new secret to `BETTER_AUTH_SECRETS` (older ones decrypt only), deploy console (or admin); 2. `pnpm fin task auth-reencrypt`; 3. after 7 days (the longest developer session) remove the old secret, deploy | `auth.secret_unreadable` stays at zero; sign-in with TOTP works | put the old secret back first in the list | wait |
| `sumsub-token` | 1. the owner creates a new token in Sumsub with the same permissions and IP allowlist; 2. set it on the holder, deploy; 3. a read with the new token; 4. disable the old token in Sumsub | no `sumsub-failing`; `provider.call` OK | re-enable the old token | disable the old token at Sumsub at once if leaked; Sumsub calls fail until Railway returns |
| `sumsub-webhook-secret` | 1. add the new secret to `SUMSUB_WEBHOOK_SECRETS` on api, deploy; 2. change it in Sumsub; 3. after 24 hours remove the old one, deploy | no `sumsub.webhook_refused` | keep both | the poll covers missed events (spec 03 §7.3) |
| `masspay-key`, `masspay-webhook-secret` | spec 04 §18.3; overlap as SP-13 records | `provider.call` OK; no `money.webhook_refused` | as spec 04 | trip `live_money` first; the status sweep covers events |
| `email-token` | 1. `pnpm fin email token <env>` mints a new token (Email Sending Edit, the group Cloudflare's token page names Email Sending Write ([BD-28]; `docs/plan/spikes.md`, run 5), IP filter to worker's egress, expiry 180 days or less); 2. set `FIN_EMAIL_TOKEN`, deploy worker; 3. the delivery check sends (`email.sent` with `ops/delivery-check`); 4. revoke the old token | the seed inbox receives the check | redeploy with the old token until it is revoked | if leaked, revoke at once: email stops until Railway returns |
| `vault-token` | 1. mint a new token scoped to the one bucket; 2. set it, deploy the holder; 3. the next anchor or dump lands; 4. revoke the old | `audit.anchor` rows grow; the next `backup-hourly` pings | keep the old until verified | revoke on a leak; anchors and dumps stop until Railway returns (`audit-anchor-failing` pages) |
| `telemetry-token`, `errors-dsn` | 1. `pnpm fin monitoring rotate-source <env> <service>` makes a new source or application token (if Better Stack cannot regenerate one, a new source with the same settings; UNVERIFIED, SP-06); 2. set it, deploy; 3. lines arrive; 4. revoke or pause the old | `no-logs-<service>` clear | the old token until revoked | lines stay on stdout only |
| `heartbeat-url` | 1. create a new heartbeat with the same settings; 2. set the variable, deploy; 3. it pings; 4. pause the old one with a recorded reason ([OB-16]) | the new heartbeat is up | the old is only paused | wait |
| `db-login` | 1. a registered task sets a new password on the idle login (`fin_api_b`) with `VALID UNTIL` the next cadence plus 30 days; 2. set `FIN_DB_USER` and `FIN_DB_PASSWORD` to it, deploy; 3. `/readyz` and a query; 4. after draining, `ALTER ROLE fin_api_a NOLOGIN`; the next rotation goes back to `_a` ([P-20]) | `pg_stat_activity` shows only `_b` | set the variables back; the old login still works until step 4 | the old login keeps working |
| `static-deploy-token`, `railway-project-token`, `betterstack-ci-token` | 1. mint a new token with the same scope; 2. once the GitHub environments exist ([BD-05]), the owner replaces the environment secret. Until then the static deploy token does not exist (each upload uses a one-run static token that `pnpm fin` mints with the operator token and revokes after the run, spec 01 §6.9), and a new Railway project token or CI Telemetry token is given at the operator machine's secure prompt; 3. a dry-run deploy proves it; 4. revoke the old | the dry run | the old until revoked | not affected (none is held on Railway) |
| `receipt-signing-key` (from hardening, D6) | 1. a new Ed25519 pair in the `fin-review` keychain; 2. a control-path pull request adds the public half to `docs/review/receipt-keys/` (owner's approval); 3. receipts switch; 4. after open pull requests are re-receipted, remove the old public key | `gate` accepts a new receipt | keep both public keys | not affected |
| `canary-key` | 1. roll the canary organisation's key in the console with a 1-hour overlap; 2. `pnpm fin monitoring apply` sets the monitor's secret from the secure prompt | `api-canary` green | the overlap | not affected |
| `postgres-superuser` | Railway's Regenerate, then a failover and `pg_rewind` test (SP-17) | Patroni healthy; services connected | none | not possible |

### 6.5 The credential inventory

`ops/credentials.json` ([OP-05]) has one row per credential per environment, never a value:

```jsonc
{
  "version": 1,
  "credentials": [
    {
      "name": "staging/email-token",
      "family": "email-token",
      "environment": "staging",
      "holders": ["worker"],
      "where": "railway-sealed",
      "issuer": "cloudflare",
      "createdOn": "2026-11-21",
      "expiresOn": "2027-05-20",
      "cadenceDays": 180,
      "runbook": "docs/runbooks/rotate-email-token.md",
      "shape": "cfat"
    }
  ]
}
```

- `where` is one of `railway-sealed`, `github-environment`, `secure-prompt`, `keychain`,
  `better-stack`, `watcher-secret`, `db-sealed`, `offline`. `shape` names a row of
  `scrub-shapes.ts`, or is `none` with a `shapeReason`.
- `monitoring:check` (MC-09) fails when a family of §6.2 has no row for an environment that uses it,
  a runbook file is missing, `expiresOn` is later than `createdOn` plus `cadenceDays`, or a `shape`
  is unknown.
- **Expiry warnings** ([OP-05]): the `credential-check` duty (worker, daily) reads the inventory the
  release carries and writes `credential.expiring` (`name`, `daysLeft`) at 30 and 14 days (N) and 7
  days (P), and `credential.rotation_overdue` past the cadence (N). In production the watcher also
  reads Cloudflare token expiries from the tokens' own metadata with its read-only token. The duty
  pings `secret-rotation-90d`, `secret-rotation-180d` and `secret-rotation-yearly` only while every
  credential of that cadence is within it, so an overdue rotation also shows as a late heartbeat.

### 6.6 What a leak enables, and the first move

| Family | A holder of a leaked value can | First move | Then |
|---|---|---|---|
| `tunnel-token` | run a connector and receive and answer a share of real traffic | §8.2 (evict) | the exposure assessment, §8.2 step 10 |
| `ingress-proof` | nothing alone; with a private-network foothold, pass the proof check | rotate (§6.4) | check `ingress.untrusted_peer` history |
| `caller-key` | sign door calls as that caller to every callee | rotate with `--emergency` (callees drop the old public key at once) | review `request` lines on callees for that caller |
| `seal-key`, `index-key` | with a database copy, open personal data | rotate and re-seal; treat every sealed value as disclosed if a dump also leaked | the breach clock (§8.5) |
| `money-seal-key`, `money-index-key` | with a database copy, open bank numbers | trip `live_money`; rotate and re-seal | the breach clock |
| `api-key-pepper` | with the key table, test guesses offline (keys are 32 random base62 characters, so impractical) | rotate in routine order | none |
| `better-auth-secrets` | forge signed cookies around a known session token; with the database, decrypt TOTP secrets | rotate; end every session of the realm | ask every developer with an authenticator to re-enrol it if the database also leaked |
| `sumsub-token` | read or write applicants within the token's permissions, from an allowed address | disable it in Sumsub | ask Sumsub for its access log; treat every applicant it could read as disclosed (ARCHITECTURE §6.5) |
| `masspay-key` | call MassPay as Fin within its allowlist | trip `live_money`; revoke at MassPay | reconcile every transfer since the exposure |
| `email-token` | send mail as Fin, edit suppressions | revoke it | read Cloudflare's counts and the suppression changes ([EM-02] finding) |
| `vault-token` | write new objects into its one bucket (locks stop overwrites and deletes) | revoke it | the watcher's inventory for unexpected objects |
| `telemetry-token`, `errors-dsn` | inject lines or errors | rotate | ignore lines from the old token's window during triage |
| `heartbeat-url` | keep a dead duty looking alive | rotate | check the duty's second check (§7.7) |
| `db-login` | act as that service in Postgres within its grants; the audit guard still refuses critical writes without events | rotate with `--emergency` (disable the old login at once) | `privileged-login`, `audit-guard` history |
| `static-deploy-token` | replace every page of the environment | revoke at once; re-render and re-upload the release's attested artefact with `tools/static-deploy`, through Cloudflare's API ([BD-16]): `pnpm fin static render <env> --release <current sha>`, then `node tools/static-deploy/src/main.ts <env> --release <current sha>` | the watcher's manifest check; `rotate-static-deploy-token.md` |
| `railway-project-token` | deploy and configure every service in the project | revoke in Railway | export Railway's audit log at once; the Railway variable leak playbook (§8.3) |
| `receipt-signing-key` (from hardening, D6) | sign a review receipt | remove its public key from `docs/review/receipt-keys/` (owner) | re-review every merge since the exposure |
| `watcher-tokens` | read configuration (they hold no write scope) | rotate | none |

---

## 7. Observability on Better Stack (R5)

### 7.1 Shape

ARCHITECTURE §10.1 and spec 01 §8.1 to §8.2 hold: one organisation, teams `fin-staging` and
`fin-production`, data region `europe` (staging: `us_west`, [BD-24]), two-factor enforced, every AI
feature off, no MCP connection and no standing agent token ([OB-02], [OB-10]). Production repeats
staging's objects under `fin-production` (H-06) with paging policies. Names:

| Object | Name |
|---|---|
| Source | `fin-next-<env>-<service>` for `edge`, `api`, `worker`, `payments`, `console`, `admin`, `verify`, `migrate`, `backup`, `connector` (all `cloudflared-*`), `watcher`, `ops`; and `fin-next-<env>-cloudflare` (platform `cloudflare_logpush`, hardening) |
| Errors application | `fin-next-<env>-<service>` (`node_errors`) for each server service; `fin-next-<env>-console-web`, `-admin-web`, `-verify-web`, `-docs-web` (`react_errors`, the last one fed only by the edge's docs reports) |
| Incoming webhook | `railway-deployments` (spec 01 §8.6) |
| Severities | `page`, `notify`, `quiet` (§7.9) |
| Policies | `production-page`, `production-notify`, `production-canary`, `staging-quiet` |
| On-call schedule | `fin-production-primary` |
| Dashboards | "Fin Services", "Fin Security" (§7.10) |
| Status page | `status.<hosted zone>` (production, [OB-09]; never on the main or the admin zone) |

### 7.2 One line per unit of work

**The envelope** (`packages/server/src/telemetry/lines.ts`, P0-D; ARCHITECTURE §10.2):

```ts
export type ServiceName =
  | "edge" | "api" | "worker" | "payments" | "console" | "admin" | "verify" | "migrate" | "backup"
  | "cloudflared-public" | "cloudflared-public-b" | "cloudflared-admin" | "cloudflared-admin-b"
  | "cloudflared-db" | "watcher" | "ops";

export interface Envelope {
  dt: string;                    // RFC 3339 UTC with milliseconds, from the unit's Clock
  message: string;               // equal to `event` (Railway needs `message`)
  event: CatalogEventName;       // a name in ops/monitoring/catalog/*.ts
  level: "info" | "warn" | "error";   // never "debug" in staging or production
  service: ServiceName;
  environment: "development" | "ci" | "staging" | "production";
  release: string;               // the 40-hex commit SHA (FIN_RELEASE)
  replica: string;               // Railway's replica ID (its variable name recorded by SP-03), "watcher", or the run ID for ops
  requestId?: string;            // req_..., for request units
  runId?: string;                // job_... for duties and queue items, run_... for pnpm fin runs
  truncated?: true;              // set when a value was cut to keep the line under 8 KB
}
```

**Units and their lines.** Every unit writes exactly one terminal line; a unit may also write named
event lines (a failure, a security refusal) before it ends. The origin gate's refusal is one: it
writes one `csrf.refused` line with `reason` (the refusal code) and `route` (the route pattern)
([SA-44]; spec 01 §8.9, catalogued in `platform.ts`), and the `request` line that ends the unit
carries `outcome: refused` and `reason: origin_gate.<code>`.

| Unit | Terminal line | Written by | When |
|---|---|---|---|
| An HTTP request | `request` | every HTTP service, from `packages/server`'s request middleware | when the answer has been sent |
| One run of a duty, or one queue item | `job.run` (and `job.step` per step) | worker, payments, backup, migrate tasks | when the run ends |
| A process event | `process.start`, `process.health` (every minute), `shutdown.started`, `shutdown.done`, `shutdown.forced`, `process.uncaught_exception`, `process.unhandled_rejection` | every Fin process | each in its own unit |
| A connector minute | `connector.health` (every minute); `connector.state`, `connector.exited` | the connector supervisor | |
| A watcher minute | `watcher.run`, then one `watcher.check_failed` per failing check | the watcher | every minute |
| A `pnpm fin` run | `run.done` (after `run.registered` and any `deploy.*`, `rotate.step`, `reseal.batch`) | `ops/fin`, shipped to the `ops` source | at the end of the run |
| A browser report | `browser.report` or `csp.report`; `page_failed` for the docs | the app API services' relays; the edge for the docs | per accepted report |

**The `request` line**, beyond ARCHITECTURE §10.2's fields:

```ts
export interface RequestLine extends Envelope {
  event: "request";
  method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
  route: string;                 // the route template, never the raw path: "/v4/customers/:id"
  status: number;
  statusClass: "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
  durationMs: number; dbMs: number; dbQueries: number;
  providerMs: number; providerCalls: number; bytesOut: number;
  cfRay: string | null;
  actor: "api_key" | "session" | "staff" | "link" | "anonymous" | "provider_webhook"
       | "browser_report" | "service";
  orgId?: string; keyId?: string; userId?: string; staffId?: string;
  mode?: "sandbox" | "live";
  outcome: "ok" | "refused" | "shed" | "error";
  reason?: ReasonCode;           // a bounded code, never free text
  rateLimited?: boolean;
  stepUp?: "window" | "intent";
  errorId?: string;              // the Errors event ID when reportError ran
}
```

Area fields are declared in the area's catalogue fragment and typed there: spec 02 §18.1 (`realm`,
`authPath`, `assurance`, `gate`, `stepUpOutcome`), spec 05 §10.1 (`operationId`, `idempotency`,
`keyReason`, `fromDocs`, `corsPreflight`, `finVersion`, `violatedPolicies`, `forwardMs`), spec 04
§30.1. A field not declared is refused by the type and by MC-03.

**`ReasonCode`** is the string-literal union of every area's `reasons` array in its catalogue
fragment, each matching `^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$` and at most 64 characters, for example
`origin_gate.app_header`, `policy.blocked`, `limits.code_send`. A free string is a type error, so the
label stays bounded.

**The `job.run` line** is ARCHITECTURE §10.2's (`job`, `trigger`, `scheduledAt`, `lagMs`,
`durationMs`, `result`, `skipReason`, `attempt`, `processed`, `failed`, `stuck`, `oldestDueS`,
`provider`, `heartbeat`), with `skipReason` one of `leased`, `disabled`, `no_work`, `switch`. A duty
may declare extra numeric fields in the catalogue; the database probe (`job: "db-probe"`) declares
`archiverLagS`, `archiverFailed`, `replicas`, `replayLagS`, `syncState`, `timeline`, `longestTxS`,
`connections`, `connectionsByRole` (an object of counts), `sizeMb` and `auditUnsequencedS`.

**The `provider.call` line** is ARCHITECTURE §10.2's, written by the adapter's sink in
`packages/{kyc,money,email}`, with spec 04 §30.1's `effect` and `subjectId`. A new provider is
monitored by implementing its port; the conformance suites check the line is written (R8).

**Process and connector lines** are ARCHITECTURE §10.2's and spec 01 §8.9's.

**This spec's own event lines:**

| Event | Kind | Fields | Written by |
|---|---|---|---|
| `error.unexpected` | failure | `errorId`, `errorName`, `code`, `route` or `job` | `reportError`, beside every unexpected error |
| `telemetry.ship_failed` | failure (stdout only) | `status`, `linesLost` | the transport |
| `telemetry.recovered` | failure | `failedSends`, `linesLost`, `statuses` | the first successful batch after a failure |
| `audit.write_failed` | failure | `event`, `sqlstate` | `recordAudit` |
| `database.audit_guard` | security | `table` | the unit of work on `FA010` |
| `database.privileged_login` | security | `role`, `registered` | the worker's matcher |
| `database.grants_drift` | security | `role`, `missing`, `extra` (counts) | the hourly drift check |
| `audit.head`, `ledger.head` | info | `epoch`, `seq`, `hash` | `audit-anchor` |
| `audit.check` | unit detail | `result`, `epoch`, `checkedFrom`, `checkedTo`, `anchors` | `audit-check` |
| `audit.check_failed`, `audit.head_moved_back`, `audit.head_not_extending`, `audit.anchor_conflict` | security | `epoch`, `seq`, `reason` | the verifier, the anchor duty |
| `journal.unshipped` | failure | `oldestS`, `count` | `journal-ship` |
| `credential.expiring`, `credential.rotation_overdue` | failure | `name`, `daysLeft` or `daysOver` | `credential-check` |
| `canary.daily`, `canary.test_page` | info | `day` | worker: once a day, and once a week, at the overlay's times (§7.9) |
| `switch.refused`, `switch.tripped` | security | `switch`, `reasonCode` | the switch reads, `ops.trip_switch()` |
| `escrow.opened` | security | `family`, `version`, `runId` | `pnpm fin escrow open` |
| `email.sent`, `email.send_failed`, `email.folded`, `email.security_unsent` | unit, failure | `template`, `class`, `code`, `reason`, IDs | the sender (L-SAT-05) |
| `browser.report` | unit | `app`, `kind` (`error`), `accepted`, `droppedReason` | the envelope relays |
| `csp.report` | security | `app`, `directive`, `blockedOrigin`, `disposition`, `sourceOrigin`, `route` | the policy report relays |
| `watcher.run`, `watcher.check_failed` | unit, security | `checks`, `failed`; `check`, `target`, `detail` (a code) | the watcher |
| `run.registered`, `run.done`, `deploy.started`, `deploy.step`, `deploy.done`, `deploy.failed`, `rotate.step`, `reseal.batch` | unit | `command`, `step`, `result`, `release`, `family`, `remaining` | `ops/fin` |

**The catalogue** (`ops/monitoring/catalog/<area>.ts`, one fragment per area, owned by its lane):

```ts
export interface CatalogEntry {
  event: string;                                  // as written in code
  kind: "unit" | "failure" | "security" | "money" | "info";
  level: "info" | "warn" | "error";
  fields: Record<string, "string" | "number" | "boolean" | "string[]" | "object">;
  reasons?: readonly string[];                    // the ReasonCode values this area adds
  alerts: readonly string[];                      // alert names in ops/monitoring/<env>/alerts/*.json
  noAlert?: string;                               // required when alerts is empty and kind is failure, security or money
}
export const entries: readonly CatalogEntry[];
```

This spec's fragments are `platform.ts`, `audit.ts`, `database.ts`, `email.ts` and `ops.ts`.

### 7.3 Transport

ARCHITECTURE §10.3 and [OB-03] hold. The module (`packages/server/src/telemetry/`, P0-D):

```ts
export function log<E extends CatalogEventName>(event: E, fields: FieldsOf<E>, level?: Level): void;
export function withUnit<T>(unit: UnitStart, fn: () => Promise<T>): Promise<T>;   // AsyncLocalStorage batch
export function shipAfter(work: Promise<unknown>): void;   // background work that logs after the answer
export function flush(deadlineMs: number): Promise<void>;  // shutdown and crash paths
```

| Constant | Value |
|---|---|
| Largest line | 8 KB; longer string values cut, with `truncated: true` |
| Largest batch | 256 KB before gzip; one POST per unit, plus one every 5 s from the process queue |
| Queue | 1,000 lines; past it the oldest are dropped and counted |
| Send | `POST https://<FIN_TELEMETRY_HOST>/` with `Authorization: Bearer <FIN_TELEMETRY_TOKEN>`, `Content-Type: application/json`, `Content-Encoding: gzip`; timeout 3 s |
| Retry | once, on a network error, 429 or 5xx; never on 4xx |
| On failure | swallowed; `telemetry.ship_failed` on stdout; the next good batch carries `telemetry.recovered`; a 402 counts towards `telemetry-gaps` |
| Shutdown | flush within `FIN_DRAIN_SECONDS`; on a crash, an awaited 2 s flush before exit |
| Start | a process missing `FIN_TELEMETRY_HOST`, `FIN_TELEMETRY_TOKEN` or `FIN_ERRORS_DSN` exits 78 |

Every line goes through `scrubLine` before stdout and before the POST. The watcher ships the same
shape with its own small sender (it is a Worker: `fetch` only, no AsyncLocalStorage), from
`ops/watcher/src/ship.ts`, with the same scrubber imported from `packages/core`. The transport and
the scrubbers run in the Bun canary job too (R15).

### 7.4 Metrics

Logs-to-metrics per source, defined in `ops/monitoring/<env>/metrics.json` before the first deploy
([OB-05]). Each entry is `{ "source", "name", "sql_expression", "type", "aggregations" }`, with
expressions of the form `JSONExtract(raw, '<field>', 'Nullable(<type>)')`. Labels (`aggregations: []`,
type `string_low_cardinality`): `event`, `level`, `service`, `environment`, `statusClass`, `route`,
`outcome`, `reason`, `job`, `result`, `skipReason`, `provider`, `operation`, `failure`, `mode`,
`template`, `class`, `check`, `realm`. Values:

| Metric | Field | Type | Aggregations |
|---|---|---|---|
| `lines` | (each row) | `int64` | `count` |
| `duration_ms` | `durationMs` | `float64_delta` | `avg`, `max`, `histogram` |
| `db_ms`, `db_queries` | `dbMs`, `dbQueries` | `float64_delta` | `avg`, `max` |
| `provider_ms`, `provider_calls` | `providerMs`, `providerCalls` | `float64_delta` | `avg`, `max`, `sum` |
| `lag_ms`, `oldest_due_s`, `stuck`, `processed`, `failed` | as named | `float64_delta` | `max`, `sum` |
| `event_loop_p99_ms`, `heap_used_mb`, `rss_mb`, `pool_waiting`, `clock_skew_ms` | `process.health` fields | `float64_delta` | `max` |
| `connections`, `restarts` | `connector.health` fields | `float64_delta` | `min`, `max` |
| `archiver_lag_s`, `replay_lag_s`, `longest_tx_s`, `audit_unsequenced_s`, `size_mb` | the probe's fields | `float64_delta` | `max` |

No ID is ever a label (MC-06). Per-organisation questions use raw-log SQL explorations, never alerts,
because raw-log alerts share four concurrent queries.

### 7.5 Errors, back and front

**Server** ([OB-04], ARCHITECTURE §10.5). `packages/server/src/report.ts` creates one client per
process on `@sentry/core` (`11.16.0` once it clears the release age, else `11.14.0`, ARCHITECTURE
§3.3):

```ts
export function createReporter(cfg: { dsn: string; release: string; environment: string; service: ServiceName }): void;
export function reportError(error: unknown, ids: {
  requestId?: string; runId?: string; route?: string; job?: string;
  orgId?: string; keyId?: string; userId?: string; staffId?: string; provider?: string;
}): string;   // returns errorId and writes error.unexpected with safeError fields
```

Options: `sendDefaultPii: false`, `release`, `environment`, `beforeSend: scrubEvent`,
`beforeBreadcrumb: scrubBreadcrumb`, no tracing, `tracePropagationTargets: []`, no context lines,
`withIsolationScope` per unit. `FIN_ERRORS_DSN` must match the regex SP-06 records in
`packages/server/src/report-dsn.ts` (Better Stack's shape for region `europe`; staging: `us_west`,
[BD-24]); any other value exits 78. Node runs with `--enable-source-maps`, so server frames arrive
mapped. `console.error(error)` is a lint error.

**`scrubEvent`** keeps the exception type, a message only for `FinError`, frames (file, line, column,
function) and the tags of the IDs above; it drops `request` (cookies, headers, query, data), `user`,
`contexts.device`, `contexts.os` beyond its name, `extra`, `server_name` and every breadcrumb but
`navigation` ones carrying a route template; then it runs `scrubText` over every remaining string.

**Browser** (console, Fin Admin, verify, selfie). `packages/frame/src/report/` (P0-G; spec 06 §2.6 owns `packages/frame` and this path) loads
`@sentry/react` after first paint, queueing up to 20 errors before, with:

- `dsn: "https://fin@relay.invalid/1"`, a placeholder: the relay ignores it and forwards to the app's
  `FIN_BROWSER_ERRORS_DSN`, so no Better Stack identifier reaches a browser or `env.json` (D08-12);
- `tunnel: "/api/monitoring/envelope"`, same origin;
- `release` and `environment` from `/env.json`; `sendDefaultPii: false`;
- `defaultIntegrations: false`, then only the global handlers, linked errors and dedupe;
- no replay, no feedback (both inject styles), no console, DOM or fetch breadcrumbs;
- `beforeSend` running the same `scrubEvent` (it is browser-safe).

`reportBrowserError(error, ids: { route: string; action?: string })` is what `ReportFailures` calls
(research D3 §3).

**The envelope relay** (`packages/web-host/src/monitoring/envelope.ts`, `POST /api/monitoring/envelope`
on the console, admin and verify API services, verify also answering for the selfie host):

1. Load shedding first: per-replica token buckets of 30 a minute per address and 600 a minute in all;
   excess answers 429 with no body and counts towards `browser-reports-lost`.
2. Refuse a body over 200 KB (413), a `Sec-Fetch-Site` other than `same-origin` when present (204,
   dropped), a content type other than `text/plain;charset=UTF-8` or `application/x-sentry-envelope`.
3. Parse the envelope; keep only `event` items; drop `session`, `attachment`, `replay_*`, `profile`,
   `transaction`, `client_report` and anything unknown.
4. Run `scrubEvent` on each event, re-serialise, and POST to the Better Stack ingest URL derived from
   `FIN_BROWSER_ERRORS_DSN` with a 3 s timeout, after the answer.
5. Answer 200 `{}` with `Cache-Control: no-store`, whatever happened upstream; write `browser.report`.

The relay reads no cookie, needs no session and changes nothing, but it is not exempt from the
origin gate: [SA-44] exempts only `GET /api/auth/callback/google` (ARCHITECTURE FW-C09, §10.5). The
browser posts the envelope itself, with no `X-Fin-App` and a body that is not JSON, so as the
register stands the gate refuses it, and the page-policy relay below in the same way. Exempting both
needs the owner to amend [SA-44] through DECISIONS appendix C (EXECUTION §3.1, spec 01 §4.4, spec 02
§2.3 and AC-SAT-27 then follow); until then neither relay holds an exemption. It holds no database
login; its caps are per replica, because a report must cost no database work ([SA-42]).

**The page-policy relay** (`packages/web-host/src/monitoring/csp.ts`, `POST /api/monitoring/csp`):
each app's `_headers` adds `Reporting-Endpoints: csp="/api/monitoring/csp"` and appends `; report-to
csp` to the page policy of ARCHITECTURE §7.12 (D08-13). The `docs` profile is excluded: the docs host
has no `/api/`, so it carries neither header and reports through spec 05 §8.13's `csp` stage at the
edge (spec 01 §7.4, spec 05 §8.11). The relay accepts `application/reports+json`
and `application/csp-report`, with the same caps and size rule, keeps `effectiveDirective`,
`disposition`, the blocked URL's origin only, the source file's origin only, and the document's route
template (matched against the app's route list, or `unknown`), and writes `csp.report`. It never
forwards to Errors.

**The docs site** reports to the edge (spec 05 §8.13, D05-01, D05-05): no `@sentry/*` there, because
Try it holds a key.

**Releases and source maps**: ARCHITECTURE §10.5 and §11.7 hold. `pnpm fin deploy` registers the
release with every Errors application of the environment (`POST
https://errors.betterstack.com/api/v1/releases`). The browser maps go from the build ([FD-19]): the
build keeps them as the release's source-map artefact. In staging, until the owner is back,
`pnpm fin sourcemaps upload` uploads that artefact from the operator machine, with staging's CI
Telemetry token read from its owner-only file there (§6.1, L1; [SA-22]; [FD-19]); from then the
`sourcemaps-staging` job does, with that token from the `staging` environment ([BD-05]). In
production the operator's launcher does, and production's token only ever comes from the secure
prompt. No `*.map` is ever served: the build deletes the maps from `dist/`, and [BD-13]'s edge rule
refuses a `*.map` path.

**Triage, not paging.** Errors notifies by email on new and reoccurring errors in production; paging
comes from log alerts on `error.unexpected` and `process.*` lines.

### 7.6 Monitors

Each monitor checks every 60 s from regions `us` and `eu` (and `as` in production), with a request
timeout of 15 s, a confirmation period of 120 s, a recovery period of 180 s, certificate warning at
14 days and domain warning at 30 days, `follow_redirects: false`, and the secret monitor header
(§6.2 `monitor-header`). Production routes to `production-page` or `production-notify` as marked;
staging to `staging-quiet`. A monitor's name is a Better Stack label, not a host: every `*-health`
monitor checks an app host's own `/api/health` (OD-3), and none points at the fallback's per-app API
hosts, which are not needed: S-01 passed on 21 Nov (SP-25; `docs/plan/spikes.md`).

| Monitor | Check | Expect | Production |
|---|---|---|---|
| `api-health` | `GET https://api.<zone>/health` | 200 | page |
| `api-canary` | `GET https://api.<zone>/v4/whoami` with the canary key ([OB-14]) | 200 | page |
| `api-unauthenticated` | `GET https://api.<zone>/v4/whoami`, no key | 401 with `errors/unauthenticated` | page |
| `console-sign-in` | `GET https://console.<zone>/sign-in` | 200 with the shell's keyword | page |
| `console-api-health` | `GET https://console.<zone>/api/health` | 200 JSON | page |
| `admin` | `GET https://admin.<zone>/` | 302 to the Access sign-in | page |
| `admin-api-health` | `GET https://admin.<zone>/api/health`, no Access token | Access's redirect, as S-01's check (i) recorded on 21 Nov for `/api/` and `/api/ping` (SP-25); proves Access covers `/api/*`. Fails if the answer carries `Fin-Release` or Fin's `errors/access_required` problem, which only the admin API half sends (spec 02 §18.4) | page |
| `verify` | `GET https://verify.<zone>/` | 200 with keyword | page |
| `verify-api-health` | `GET https://verify.<zone>/api/health` | 200 JSON | page |
| `selfie` | `GET https://selfie.<zone>/api/health` | 200 JSON | notify |
| `docs` | `GET https://developer.<zone>/` | 200 with keyword | notify |
| `docs-openapi` | `GET https://developer.<zone>/openapi.json` | 200 | notify |
| `status` | the status page | 200 with keyword | notify |
| `journey-sign-in` (if [OB-12] is yes) | a Playwright journey on a canary account with a read-only role, every 15 minutes | its steps pass | notify |

The admin API's own liveness is covered by `no-logs-admin` and its `process.health` lines, not by a
monitor, because a monitor that passes Access would need an Access service token (D08-14).

### 7.7 Heartbeats

One per independent duty, pinged at the end of a run that finished (`/fail` with the exit code when
it failed). Each URL is a sealed variable of the one process that pings it. Grace periods are in the
overlay.

| Heartbeat | Period | Pinged by | Second check | Production |
|---|---|---|---|---|
| `scheduler-worker` | 60 s | worker, each minute it holds the lease | `no-logs-worker` | page |
| `scheduler-payments` | 60 s | payments' scheduler | `no-logs-payments` | page |
| `webhook-dispatcher` | 60 s | the dispatcher loop | `webhook-dispatcher-stalled` | page |
| `provider-sync` | 60 s | payments' money loop | `provider-sync-stalled` | page |
| `audit-check` | 1 hour | `audit-check` | `audit-head-line-regressed` | page |
| `backup-nightly`, `backup-hourly` | 1 day, 1 hour | backup | the watcher's vault inventory (`backup-stale`) | page |
| `reconcile-daily` | 1 day | payments | its `job.run` line | page |
| `sandbox-purge`, `erasure-sweep`, `credential-check` | 1 day | worker | their `job.run` lines | notify |
| `email-delivery-check` | 1 day | worker (spec 01 S0-09) | `email-not-sent` | page |
| `watcher` | 60 s | the watcher | `pnpm fin verify` | page |
| `verify-daily` | 1 day | the scheduled `pnpm fin verify` | none | notify |
| `restore-check` | 7 days production, 31 staging | the restore check (§8.4) | its report | notify |
| `restore-drill` | 31 days production, 100 staging | the drill (§8.4) | its report | notify |
| `secret-rotation-90d`, `-180d`, `-yearly` | 1 day | `credential-check`, only while every credential of that cadence is within it | `rotation-overdue` | notify |
| `canary-delivered` (production) | 1 day | the `production-canary` policy's webhook step (§7.9) | the responder | page |
| `review-nightly` | 1 day | fin-review's nightly run (ARCHITECTURE §11.6) | `review-run-slow` | notify |

### 7.8 The alert set

**The file shape** (`ops/monitoring/<env>/alerts/<area>.json`, one per area, owned by its lane):

```json
{
  "alerts": [
    {
      "name": "audit-unsequenced",
      "group": "D",
      "severity": "P",
      "source": "worker",
      "query": { "metric": "audit_unsequenced_s", "aggregation": "max" },
      "operator": "higher_than",
      "threshold": "@thresholds.audit-unsequenced",
      "check_period": 60, "query_period": 300, "confirmation_period": 60, "recovery_period": 300,
      "on_missing_data": "dont_fire",
      "incident_cause": "Audit rows are waiting to be chained. Value: {{current_value}} s.",
      "metadata": { "check": "The worker's scheduler lease and the sequencer's last job.run line.",
                    "flow": "F15", "runbook": "docs/runbooks/audit-unsequenced.md" }
    }
  ]
}
```

`threshold` names an overlay key, which `pnpm fin monitoring apply` fills in ([OB-13]); the file never
holds the number. `severity` is `P` (production pages through `production-page`) or `N` (production
notifies through `production-notify`); every staging alert goes to `staging-quiet`. `query` is either
a metric of §7.4 or `{ "sql": "<a saved exploration name>" }` for raw-log alerts.

**Groups A, B, H, I and J: full rows** (this spec's fragments). Group D's rows are in §3.14.

| Alert | Grp | Sev | Fires on | Means | First check | Runbook |
|---|---|---|---|---|---|---|
| `no-logs-<service>` | A | P (N while every monitor is green) | no line from the source in its window, `on_missing_data: start_incident` | the service stopped, or its shipping did | Railway's deployment state; stdout `telemetry.ship_failed`; Better Stack's status (EU ingest delays) | `no-logs.md` |
| `deploy-outside-window` | A | P | a `railway-deployments` event whose digest is in no open registered window | someone deployed outside `pnpm fin` | the ops bucket's run registrations; export Railway's audit log at once | `deploy-outside-window.md` |
| `process-crash` | A | P | any `process.uncaught_exception` or `process.unhandled_rejection` | an unhandled error killed a process | the Errors application for the release | `process-crash.md` |
| `process-restarts` | A | N | `process.start` above its count per service in 15 minutes | a crash loop or memory kills | `memory-high`; crash lines | `process-crash.md` |
| `shutdown-forced` | A | N | any `shutdown.forced` | draining ran out | slow background work; `FIN_DRAIN_SECONDS` | `process-crash.md` |
| `event-loop-stalled` | A | N, P when severe | `event_loop_p99_ms` above its thresholds for 5 minutes | the process is blocked | heavy requests; argon2id bursts; `UV_THREADPOOL_SIZE` | `event-loop.md` |
| `memory-high` | A | N | `rss_mb` above its share of the limit for 10 minutes | a leak or a large load | heap growth by release | `event-loop.md` |
| `clock-skew` | A | N, P when large | `clock_skew_ms` above its thresholds | the process and the database disagree on time | the host; Railway's status | `clock-skew.md` |
| `dns-lookup-failing` | A | N | any `dns.lookup_failed` | private DNS failing | Railway's private network | `private-dns.md` |
| `telemetry-gaps` | A | N | `telemetry.recovered` with `linesLost` above zero, or any 402 | lines were lost | ingest status codes (402 quota, 403 token) | `telemetry-gaps.md` |
| `telemetry-spend-high` | A | N | Better Stack's spend alert at 80% of the forecast | ingest is above plan | volume by source; a flood of reports | `telemetry-gaps.md` |
| `canary-missing` | A | P | heartbeat `canary-delivered` late | the daily canary did not reach the pager path | §7.9's canary steps | `canary-missing.md` |
| each monitor of §7.6 | A, B | as §7.6 | monitor down after confirmation | the host does not answer as expected | the service's lines; the connector count | `monitor-<name>.md` |
| each heartbeat of §7.7 | A | as §7.7 | heartbeat late or failed | the duty stopped | the duty's last `job.run` | `duty-stalled.md` |
| `5xx-rate-<service>` | B | P | 5xx over requests above its ratio with a minimum count, or an absolute count | errors served | top `route` by 5xx; the last release | `5xx-rate.md` |
| `db-or-door-down-<service>` | B | P | `process.health` with `dbOk` or `doorOk` false for 2 minutes | the service cannot reach Postgres or its door | `database-unreachable`; the callee's health | `db-or-door-down.md` |
| `tunnel-connectors` | B | P | `watcher.check_failed check=connectors` | a connector of the wrong count, version or origin: a possible leaked token | §8.2 steps 1 and 2 | `evict-tunnel.md` |
| `tunnel-config-drift` | B | P | `check=tunnel-config` or `check=dns` | a tunnel became remotely managed, or one of fin-next's records points elsewhere | the registered runs; Cloudflare's audit log | `tunnel-config-drift.md` |
| `railway-exposed` | B | P | `check=railway`, or `pnpm fin verify` | a service has a public domain or a TCP proxy | Railway's audit log; remove it | `railway-exposed.md` |
| `static-deployment-changed` | B | P | `check=routes` or `check=static` | a Worker was attached, a route changed, or a page differs from the release | §8.5's static playbook | `static-deployment-changed.md` |
| `cloudflare-config-changed` | B | P | `check=rules`, `zone` or `access` | one of fin-next's own rules (`ref` starting `fin_next_`, [BD-11]), a zone setting, or fin-next's Access application or policy changed outside a run; the old product's rules on the shared zone are not fin-next's ([FD-09]) | Cloudflare's audit log | `cloudflare-config-changed.md` |
| `ingress-untrusted-peer` | B | P | any `ingress.untrusted_peer` | something on the private network called a service directly | the peer's service; a redeploy that reused an address | `ingress-untrusted-peer.md` |
| `caller-signature-invalid`, `outside-request` | B | P | any `caller.signature_invalid`; any `api.outside_request` | a forged or stale signed call, or an operation outside the door matrix | a half-done caller-key rotation; the calling service | `outside-request.md` |
| `tunnel-530-1033` | B | P | Logpush: 530 or 1033 counts per host above zero for 3 minutes (hardening) | a tunnel has no healthy connector | the connector services | `evict-tunnel.md` |
| `waf-blocks-spike` | B | N | Logpush: WAF rate-rule blocks above their baseline | an attack or a misbehaving client | the rule and the host | `waf.md` |
| `csp-reports` | B | N, above a volume | `csp.report` count | a page broke its policy, or someone injects | the directive and the release | `csp-reports.md` |
| `browser-reports-lost` | B | N | relay caps dropping reports | a report flood | the addresses' spread in Logpush | `csp-reports.md` |
| `database-unreachable` | H | P | `database.pool_error` or failed probe runs for 2 minutes | Postgres is down for Fin | Railway's Postgres state | `database.md` |
| `pool-exhausted` | H | P | `pool_waiting` above zero for 5 minutes | requests wait for connections | long transactions; pool sizes | `database.md` |
| `connections-high` | H | N | the probe's `connections` above its share of 497 | near the connection budget | replicas times pool max | `database.md` |
| `database-size` | H | N, P when nearly full | `size_mb` above its shares of the volume | the volume fills | growth by table | `database.md` |
| `long-transactions` | H | N | `longest_tx_s` above 5 minutes | a session holds a transaction | the holder in `pg_stat_activity` | `database.md` |
| `wal-archiving-stalled` | H | P | `archiver_lag_s` above 5 minutes, or `archiverFailed` rising | PITR has a gap (pgBackRest drops WAL rather than halting) | the PITR-gap runbook: a manual base backup | `pitr-gap.md` |
| `replica-missing`, `replication-lag`, `sync-standby-missing` | H | P when none; N, P when large; P while [P-10] is on | the probe's `replicas`, `replay_lag_s`, `syncState` (production) | HA is degraded | Patroni's state | `database-ha.md` |
| `failover-detected` | H | P | the probe's `timeline` changed | the primary moved | §3.9's failover procedure | `failover-lost-commits.md` |
| `privileged-login` | H | P | `database.privileged_login` with `registered: false` | a superuser or owner login outside a registered run | who; Railway's audit log; consider §8.3's Railway variable leak playbook | `privileged-login.md` |
| `grants-drift` | H | P | any `database.grants_drift` | live grants differ from the matrix | the last migration; `privileged-login` | `grants-drift.md` |
| `certificate-changed` | H | P | the pinned CA no longer matches | Railway rotated the certificate, or something is in the path | re-pin through a reviewed change after checking | `database.md` |
| `backup-small`, `backup-stale` | H | P | a dump far smaller than the last; the watcher's inventory finds the newest dump older than its period | backups are failing | the backup service's `job.run`; the R2 token | `backup.md` |
| `credential-expiring` | I | N at 30 and 14 days, P at 7 | `credential.expiring` | a credential expires soon | its runbook in the inventory | the row's runbook |
| `rotation-overdue` | I | N | `credential.rotation_overdue` | a rotation was missed | the inventory | the row's runbook |
| `escrow-opened` | I | P | `escrow.opened` | someone opened escrow | the registered run and its reason | `escrow.md` |
| `switch-changed` | I | N | `switch.set` or `switch.cleared` by a person | a kill switch moved | who and why, in the staff audit log | `kill-switches.md` |
| `pd-read-limit` | I | N | `kyc.pd_read` refused at the 300-per-10-minutes limit | an organisation is reading many customers' details | the organisation's members and sessions | `pd-read-limit.md` |
| `egress-high` | I | N | Railway egress above its forecast | traffic or a leak of data out | top services | `egress.md` |
| `duty-stalled-<duty>` | I | N; P for audit and money duties | no `job.run result=ok` for three cadences | a duty stopped | the duty's last line; the lease | `duty-stalled.md` |
| `monitoring-drift` | J | N | the daily dry run differs, or `paused_reason` set by Better Stack | monitoring changed outside the files | re-apply; fix the query | `monitoring-drift.md` |
| `github-settings-changed` | J | P | the watcher's hourly hash, or `pnpm fin github verify` | the ruleset or repository settings changed | the owner's GitHub security log | `github-settings-changed.md` |
| `vault-inventory-changed` | J | P | the watcher's `check=vault` | a locked object was removed or changed | R2's bucket settings; the vault account's members | `vault-inventory-changed.md` |
| `review-run-slow`, `review-cost-high` | J | N | fin-review's run lines (ARCHITECTURE §11.6) | review got slower or dearer | the run's phases | `review-metrics.md` |
| `watcher-down` | J | P | heartbeat `watcher` late | nothing is watching the front door | the watcher's deployment and cron | `watcher-down.md` |

**Group G, email** (fragment `email.json`, L-SAT-05):

| Alert | Sev | Fires on | Means | First check | Runbook |
|---|---|---|---|---|---|
| `email-not-sent` | P for `code` and `security` classes, N otherwise | `email.send_failed` by class and code | mail is failing | the code's step (ARCHITECTURE §9.3) | `email.md` |
| `email-outbox-age` | P for codes and security rows, N otherwise | the oldest due row's age | the sender is behind or stopped | the worker's email loop; Cloudflare's status | `email.md` |
| `security-email-unsent` | P | any `email.security_unsent` | a person was not told about an access change | the reason: suppressed, failed, budget | `security-email-unsent.md` |
| `email-volume-high` | P | Cloudflare's sent count above Fin's own `email.sent` count, or above the ceiling | a leaked email token | `rotate-email-token.md`'s leak section | `rotate-email-token.md` |
| `email-budget-reached` | N | the daily budget used, or the security share touched | a flood of ordinary mail | which template | `email.md` |
| `email-setting-changed` | P | the watcher's `check=email` | preview or drop-suppressed turned on, or either sending subdomain's DMARC record (`_dmarc.auth.`, `_dmarc.notify.`) gone or, on staging, no longer `p=reject` ([BD-17]) | `pnpm fin email verify` | `email.md` |
| `email-complaint`, `email-dmarc-failing` | N | Cloudflare's analytics (ARCHITECTURE §9.8) | deliverability at risk | the template and sending domain | `email.md` |

**The area alerts, by spec** (their rows, with meaning and first check, are in the spec named):

| Group | Alerts | Spec |
|---|---|---|
| B, the API | `api-latency`, `rate-limiter-failing`, `idempotency-store-failing`, `pepper-missing`, `keys-not-rehashed`, `bad-key-flood`, `load-shedding`, `key-sent-in-clear`, `key-leaked`, `secret-scanning-refused`, `edge-pool-waiting`, `docs-failing`, `webhook-host-capped` | 05 §10.2 |
| C, sign-in and roles | `sign-in-failing`, `second-factor-step-failing`, `step-up-failing`, `sign-in-failures-spike`, `step-up-locked`, `secret-unreadable`, `rate-limiter-failing`, `auth-endpoint-unlisted`, `csrf-refused-jump`, `identity-sweep-stalled`, `staff-sign-in-failures`, `admin-staff-refused`, `admin-without-second-factor`, `admin-access-mismatch`, `admin-access-drift`, `access-keys-unavailable`, `staff-changed`, `staff-enrolled`, `staff-enrolment-refused`, `duty-stalled-access-drift`, `staff-sweep-stalled`, `team-change-failing`; stretch `password-guessing-spread`, `google-sign-in-failing` | 02 §18.2 |
| E, onboarding | `sumsub-failing`, `sumsub-rate-limited`, `sumsub-webhook-refused`, `kyc-inbound-backlog`, `applicant-write-backlog`, `sumsub-poll-stalled`, `kyc-review-stale`, `go-live-queue-age`, `documents-failing`, `erasure-failing`, `kyc-unknown-applicant`, `kyc-write-refused`, `selfie-failing`, `verify-link-flood`, `5xx-rate-verify`, `reveal-budget-reached`, the `duty-stalled-*` of spec 03 §7.6 | 03 §18.2 |
| F, money and webhooks | `provider-failing`, `provider-auth-failing`, `provider-rate-limited`, `provider-latency`, `provider-webhook-refused`, `provider-sync-stalled`, `transfers-stuck`, `transfer-sent-after-end`, `idempotency-mismatch`, `reconciliation-break`, `orphan-payout`, `money-switch-tripped`, `money-durability-unconfirmed`, `ledger-unsequenced`, `holder-locked`, `provisioning-failed`, `accounts-not-closing`, `funding-low`, `provider-events-backlog`, `money-door-volume`, `simulation-refused`; `webhook-deliveries-failing`, `webhook-dispatcher-stalled`, `webhook-backlog`, `webhook-signing-failed` | 04 §30.3; 05 §10.2 |

Spec 01 §8.7's `static-deployment-changed` and `cloudflare-config-changed` (S0-10) are the names
ARCHITECTURE §5.9 and §10.8 now use too; the earlier name `static-drift` is not used.

### 7.9 Policies, on-call, the canary and the test page

- **Severities** (Better Stack urgencies): `page` (call, push, critical push, SMS, email), `notify`
  (push, email), `quiet` (email only).
- **Policies.**

  | Policy | Team | Steps |
  |---|---|---|
  | `production-page` | `fin-production` | 1: the current on-call of `fin-production-primary`, severity `page`; 2: after the overlay's wait, the next responder (or the entire team), severity `page`; repeat the overlay's count; fallback: the owner. Quiet hours never apply |
  | `production-notify` | `fin-production` | 1: the current on-call, severity `notify`; no escalation |
  | `production-canary` | `fin-production` | 1: the current on-call, severity `notify`; 2 (at once): a webhook integration that pings heartbeat `canary-delivered` (UNVERIFIED that a policy step can call a heartbeat URL; SP-06 checks it, and otherwise the alert's own outgoing webhook does) |
  | `staging-quiet` | `fin-staging` | 1: the entire staging team, severity `quiet`; no escalation ("staging stays quiet") |

- **The on-call schedule** `fin-production-primary`: the roster, its time zone and the rotation come
  from the overlay ([OB-13]); "members can upgrade to Responder" is off.
- **The daily canary** ([OB-17]): the worker writes `canary.daily` at the overlay's time; the alert
  `canary-daily` (N, any `canary.daily` line) routes to `production-canary`, so it reaches the on-call
  phones and, in the same moment, pings `canary-delivered`. If the alert or its policy is deleted or
  broken, `canary-delivered` goes late (`canary-missing`, P). A day without the canary push means
  "check Better Stack now" (D08-24; the limit it covers is TM-L12, in the private annex). The watcher
  holds no Better Stack token (ARCHITECTURE §10.6 is amended accordingly).
- **The weekly test page**: every Monday at the overlay's time the worker writes `canary.test_page`;
  the alert `test-page` (P) must be acknowledged within 15 minutes. The acknowledgement time is read by
  the operator's weekly `pnpm fin monitoring report` and recorded for PG-09.
- **The responder gate** ([OB-06], PG-09): production does not open with one responder unless all of
  these hold and the owner accepts the risk in writing: the kill switches and their automatic trips
  are tested (§8.6); the target "acknowledge a page within 15 minutes, day and night" is written in
  `docs/operations/incident-response.md` and met for four weekly test pages in a row; each
  responder's phone has received a test page with critical push and a call. Otherwise a second
  trained responder with a break-glass production role and a sealed escrow procedure.
- **The apply script refuses** (MA rules, §7.11): an object with no policy; a staging object that
  calls, texts or pushes; a production policy with no call or critical-push step; an `ai_sre` member;
  a pause without a recorded reason and date; an alert without `incident_cause`, `metadata.check`,
  `metadata.flow` and an existing `metadata.runbook`.

### 7.10 Dashboards

Kept as exported JSON in `ops/monitoring/<env>/dashboards/`, applied by the script:

- **"Fin Services"**: ARCHITECTURE §10.10's panels, with the area panels of specs 02 §18.3, 03 §18.3,
  04 §30.4 and 05 §10.4.
- **"Fin Security"** (D08-15): ingress refusals by service; origin-gate refusals by reason; blocked
  endpoints; step-up refusals and locks; staff changes and enrolments; Access drift; reveals and
  document views (counts, by staff role, never by person); personal-data reads by organisation count
  band; `audit.write_failed` and `database.audit_guard`; sequencer lag, anchors and checks;
  privileged logins; grants drift; watcher checks by result; static and Cloudflare configuration
  checks; credential days left (the inventory's nearest expiries); kill switch states; CSP reports by
  directive.

### 7.11 Monitoring as code

**Files** (`ops/monitoring/<env>/`): `sources.json`, `errors.json`, `metrics.json`, `monitors.json`,
`heartbeats.json`, `policies.json`, `webhooks.json`, `status-page.json`, `alerts/<area>.json`,
`dashboards/fin-services.json`, `dashboards/fin-security.json`; shared: `ops/monitoring/catalog/<area>.ts`,
`ops/monitoring/vrl/{logs,errors}.vrl`. No team ID, source ID, ingest host, DSN or heartbeat URL is
ever committed: files name things, and the script resolves IDs at run time ([OB-05]).

**`monitoring:check`** (`ops/monitoring/check.ts`, in `pnpm check`, no network, under a second):

| Rule | Fails when |
|---|---|
| MC-01 | an event written in code (`log("<name>", ...)` or `recordAudit` failure names) is missing from the catalogue, or a catalogue entry is written nowhere |
| MC-02 | a `failure`, `security` or `money` entry has no alert and no `noAlert` reason |
| MC-03 | a line's field is not declared in its entry, or a `reason` is outside `ReasonCode` |
| MC-04 | an alert's query names a metric or event that is not defined |
| MC-05 | a scheduled duty has neither a heartbeat nor a success alert |
| MC-06 | a metric label is ID-shaped or a free-text field |
| MC-07 | a deployed service lacks a source, an Errors application, a monitor if public, or a dashboard panel |
| MC-08 | an alert lacks `incident_cause`, `metadata.check`, `metadata.flow` (an ID in `docs/flows/atlas.json`) or `metadata.runbook`, or the runbook file does not exist |
| MC-09 | `ops/credentials.json` breaks §6.5's rules |
| MC-10 | a runbook file lacks a heading of §6.4 |
| MC-11 | an alert's `threshold` is a literal number rather than an overlay key |
| MC-12 | any file holds a Better Stack identifier, ingest host, DSN or heartbeat URL (the scrubber's shapes) |
| MC-13 | a production alert or monitor has no severity, or a staging object names a production policy |
| MC-14 | an alert name is used by two fragments |

**`pnpm fin monitoring apply <env> [--dry-run] [--confirm-delete <count>]`** (ops lane) applies the
files through Better Stack's APIs with the team tokens from the secure prompt, idempotent by name, and
refuses ([OB-16], ARCHITECTURE §10.9):

| Rule | Refuses |
|---|---|
| MA-01 | to run without printing the dry-run difference first |
| MA-02 | when the team's name does not match `<env>` |
| MA-03 | to delete more than 3 objects without `--confirm-delete <count>` equal to the number |
| MA-04 | to delete a heartbeat (it pauses it with a reason, because a recreated heartbeat gets a new URL) |
| MA-05 | an object with no policy, or an alert with email alone |
| MA-06 | a staging object that calls, texts, pushes or sends critical alerts |
| MA-07 | a production `page` policy with no call or critical-push step |
| MA-08 | any `ai_sre` member, or an AI feature turned on |
| MA-09 | a pause without `metadata.paused_reason` and a date |
| MA-10 | an overlay key that is missing for a `threshold` |

After applying it writes new ingest tokens, DSNs and heartbeat URLs straight into the services'
sealed variables through Railway's API, never printing them. `pnpm fin verify` runs the dry run daily
and reads each alert's `paused_reason`, because Better Stack can pause an alert itself
(`monitoring-drift`).

### 7.12 Cloudflare Logpush (hardening, [FD-08])

- Datasets `http_requests` and `firewall_events` per zone, to the HTTP destination of the
  `fin-next-<env>-cloudflare` source, with the bearer token passed as `header_Authorization`.
  Applied by `pnpm fin logpush apply <env>` with the operator token (Logs Edit). On the shared
  staging zone each job carries a filter that keeps only requests whose `ClientRequestHost` is one
  of fin-next's names ([FD-09]), so no request to the old product's hosts reaches Better Stack.
  `pnpm fin logpush apply staging` checks each job against [FD-09]'s allow-list before it writes,
  like every other staging write, and never changes a job it did not make (EX-27). The filter's
  form is checked against Cloudflare's Logpush reference when the job is built (UNVERIFIED).
- **Fields kept** (allowlist; anything else is never sent), for `http_requests`: `EdgeStartTimestamp`,
  `RayID`, `ClientRequestHost`, `ClientRequestMethod`, `EdgeResponseStatus`, `OriginResponseStatus`,
  `OriginResponseDurationMs`, `EdgeTimeToFirstByteMs`, `SecurityAction`, `SecurityRuleID`,
  `CacheCacheStatus`, `WorkerScriptName`, and the path's first segment only (`/api`, `/v4`,
  `/assets`, `/hooks`, `/reports`, or `/other`), made by the Transformer. For `firewall_events`:
  `Datetime`, `RayID`, `Action`, `Source`, `RuleID`, `ClientRequestHost`, `ClientRequestMethod`,
  `EdgeResponseStatus`. Never `ClientIP`, a full path, a query, a user agent, a referrer or a cookie;
  `ClientCountry` only if the owner decides country may be logged. Field names are checked against
  Cloudflare's Logpush field reference when the job is built (UNVERIFIED as names).
- Because only the first segment is kept, the verify, selfie and invitation paths are redacted by
  construction. A test sends a sample record through the Transformer's definition and checks the
  output's keys (T08-45).
- `WorkerScriptName` is kept so a Worker ever running on an app host shows up in Logpush as well as
  in the watcher's check.

### 7.13 Alert load and shadow mode

[OB-16] holds: staging evaluates the production rules in shadow (each production alert applied to the
staging team as a copy named `<name>-shadow`, routed to `staging-quiet` with `metadata.shadow:
"true"`); a saved exploration counts the shadow incidents a week; PG-04 needs the count under the
owner's number for a week (SP-22). `no-logs-*` are grouped and downgraded to N while the monitors are
green, so an ingest delay does not page every service at once.

### 7.14 The status page

[OB-09]'s default: `status.<hosted zone>`, a DNS-only CNAME to Better Stack on the hosted zone,
never the main or the admin zone (the watcher's dangling-record check names it), no custom script,
no analytics, no subscriber data from Fin, with components API, Console, Hosted verification and
Docs from the monitors. Incidents are posted by the incident commander (§8.1).

### 7.15 Tests

| ID | Level | Statement |
|---|---|---|
| T08-30 | U | Each scrubber shape and each withheld name of §5.4 is removed; a property test planting every shape in random lines and nested objects finds none after `scrubLine`, `scrubEvent` and `scrubText`; numbers are untouched (extends AC-P0-12) |
| T08-31 | U | The transport cuts a line at 8 KB with `truncated`, bounds the queue at 1,000, retries once on 429 and 5xx and never on 4xx, swallows failures with `telemetry.ship_failed`, and reports the gap with `telemetry.recovered`; it never delays the answer |
| T08-32 | U | `scrubEvent` drops `request`, `user`, `extra` and every non-navigation breadcrumb; keeps frames and the ID tags |
| T08-33 | I | The envelope relay keeps only `event` items, refuses over 200 KB, sheds above its buckets, never forwards a cookie or header, always answers 200 `{}`, and forwards to `FIN_BROWSER_ERRORS_DSN` |
| T08-34 | I | The policy relay accepts both report formats, keeps origins only, and writes `csp.report` |
| T08-35 | E2E | A thrown error in each app reaches the relay with no address, cookie, query or typed value in its body |
| T08-36 | U | `monitoring:check` fails on each planted case of MC-01 to MC-14 |
| T08-37 | U | `pnpm fin monitoring apply` refuses each case of MA-01 to MA-10, against recorded fixtures |
| T08-38 | STG | A forced alert of each severity on staging emails `staging-quiet` and no staging object calls, texts or pushes (extends AC-P0-32) |
| T08-39 | U | Every unit kind writes exactly one terminal line, even when its handler throws |
| T08-40 | I | A request from a non-connector peer, or without the host's proof, gets 403 and writes `ingress.untrusted_peer` |
| T08-41 | I | A door call signed for another audience, outside the window, replayed, or for an operation not in the matrix is refused with its line |
| T08-42 | U | `reportError` returns the `errorId` and writes `error.unexpected` with `safeError` fields only |
| T08-43 | U | `credential-check` writes `credential.expiring` at 30, 14 and 7 days and pings a cadence heartbeat only while every credential of it is within cadence |
| T08-44 | I | The database probe reports `auditUnsequencedS` above zero while the sequencer is stopped |
| T08-45 | U | The Logpush Transformer definition outputs only the allowlisted keys, and the path's first segment; the staging jobs' filter keeps only fin-next's names ([FD-09]) |

---

## 8. Incident runbooks

### 8.1 The process

`docs/operations/incident-response.md` ([OP-02], ARCHITECTURE §15.2) holds the severities (SEV1:
money or personal data at risk, or the product down; SEV2: a part down or degraded; SEV3: no user
impact yet), the incident commander named in the roster with a hand-off rule, the first 15 minutes
(acknowledge; decide the severity; a kill switch if money or data is at risk; the status page;
export Railway's audit log at once; snapshot the relevant Better Stack lines with a saved
exploration), the message templates, the 72-hour personal-data breach clock assessed at once with
counsel ([DA-08]), and the blameless review within 5 working days, stored `age`-encrypted in the ops
bucket with its action items (Issues are off in the public repository); on staging the encrypted
review waits for CR-10 ([BD-14]). Every runbook has §6.4's headings. The three this spec writes in
full are §8.2 to §8.4; §8.5 indexes the rest.

### 8.2 A leaked tunnel token: evict (`docs/runbooks/evict-tunnel.md`, [FD-15])

**When.** `tunnel-connectors` pages (a connector with the wrong count, version or origin); a Railway
or Cloudflare security notice; a tunnel token seen anywhere (a branch, a log, an artefact); a
connector service's variables exposed. Also every 90 days as the routine rotation (§6.2), without
the assessment of step 10.

**Who and what they need.** The incident commander; the operator with the Cloudflare operator token
(CR-05, Tunnel Edit and DNS Edit) and the Railway project token, both at the secure prompt.

**Severity.** SEV1 if any unexpected connector was seen; SEV2 for an exposure with none.

**Steps** (targets from the page; the drill measures them, PG-05):

1. **T+0 to T+2. Acknowledge** and open the incident. Name the tunnel: `public` or `admin` (or `db`:
   then step 9 at once, since nothing legitimate runs on it outside a registered run).
2. **T+2 to T+4. Keep the evidence.** `pnpm fin tunnel status <env> <role> --record` writes the
   connector list (connector IDs, versions, origin addresses, first-seen times) `age`-encrypted to
   the ops bucket and prints a summary; `pnpm fin railway audit-export <env>` exports Railway's
   audit log; save the `tunnel-connectors-history` exploration. On staging, until the owner gives
   CR-10, the connector list has no recipient, so it is not written ([BD-14]); the saved exploration
   keeps the history.
3. **Railway reachable?** `pnpm fin railway ping <env>`. If not, go to step 9.
4. **T+4 to T+8. Prepare.** `pnpm fin tunnel prepare <env> <role>` creates the locally managed tunnel
   `fin-next-<env>-<role>-<yyyymmddhhmm>` with the same map, fetches its token with Tunnel Edit (never
   printed), sets it as `TUNNEL_TOKEN` on the standby service (`cloudflared-<role>-b`, or
   `cloudflared-<role>` when `-b` is live; the live slot is recorded in the run registration and read
   by the watcher and `FIN_CONNECTOR_SERVICES`, which always lists both), and scales the standby to the
   expected replicas.
5. **T+8 to T+10. Wait.** `pnpm fin tunnel wait <env> <role>` polls Tunnel Read every 5 s, for up to
   5 minutes, until the new tunnel has the expected count, the pinned `cloudflared` version and only
   origins in the standby's static egress. During a registered tunnel run the watcher allows two
   tunnels for the role.
6. **T+10 to T+11. Swap.** `pnpm fin tunnel swap <env> <role>` sets every proxied CNAME of the role's
   hosts to `<new tunnel id>.cfargotunnel.com`, reads each record back, and probes `/api/health` on
   every app host of the role (and `/health` on `api.`). Any failed probe swaps every record back and
   stops. The Workers routes do not change, so the files keep being served.
7. **T+11 to T+13. Retire.** `pnpm fin tunnel retire <env> <role> --old` calls `DELETE
   /accounts/<account id>/cfd_tunnel/<old id>/connections`, then deletes the old tunnel, scales the
   old service to 0 and deletes its `TUNNEL_TOKEN`. The watcher's next run must show one tunnel for the
   role with the expected connectors and nothing else.
8. **T+13 to T+30. Rotate the role's ingress proofs** (§6.4, `--emergency`): they travelled with every
   request on the tunnel.
9. **Hard stop, when Railway is down or for the db tunnel.** `pnpm fin tunnel kill <env> <role>`
   deletes the tunnel's connections and the tunnel at Cloudflare. Every `/api/*` path of the role's
   hosts then fails at Cloudflare (530 or 1033) while the static files still load, and each screen
   shows its failure state; post to the status page. When Railway returns, run steps 4 to 7 with a
   fresh tunnel and remove the old token from both services.
10. **Within 4 hours: the exposure assessment** (D08-29). The window runs from the earliest of the
    rogue connector's first-seen time and the token's earliest possible exposure, to the delete in
    step 7 or 9. A rogue connector could read and answer any request of the role's hosts in the
    window: typed codes and passwords, session cookies, API keys, Access tokens, provider webhooks.
    - **Public tunnel:** end every developer session and every hosted-link session
      (`pnpm fin sessions end-all <env> --realm developer --links --reason security_incident`, a
      registered task writing `session.ended` and a `sessions_ended` journal entry); list every API key
      that made a request in the window (edge `request` lines by `keyId`) and email each organisation's
      Super admins and Admins with `api-keys/key-exposed` (`source: "incident"`); for live keys the
      owner decides at the incident between that notice alone and a forced expiry 72 hours later (a
      replacement never gets more); re-read every applicant with activity in the window from Sumsub
      and run the money status sweep over every non-final transfer, because the rogue connector could
      have answered provider webhooks itself; if passwords are built, require a reset for every account
      that signed in with one in the window.
    - **Admin tunnel:** end every staff session (`--realm staff`), revoke every session of Fin
      Admin's own Access application (`pnpm fin access revoke-sessions <env>`, that application's
      token revocation; on the shared staging account it never revokes a session of the old
      product's applications, [FD-09], EX-27), and review the staff audit log for the window.
    - **Both:** the personal-data breach assessment against the 72-hour clock, with counsel; tell
      Sumsub and MassPay if their webhooks crossed the window.
11. **Close.** Record the times (paged, acknowledged, decided, swapped, retired, assessed) in the
    incident; the blameless review within 5 working days.

**Verify.** The watcher's `connectors` check passes for the role; `tunnel-530-1033` is quiet; the
monitors are green; `ingress.untrusted_peer` is at zero.

**Roll back.** Until step 7, swap the records back; after it, the old tunnel no longer exists.

**Records.** The run registrations; the encrypted connector list; the incident; the drill times.

**Alerts.** `tunnel-connectors`, `tunnel-config-drift`, `tunnel-530-1033`, `ingress-untrusted-peer`.

### 8.3 Rotating keys under pressure (`docs/runbooks/rotate-emergency.md`)

**When.** A leaked value of any family of §6.2, or a platform notice that variables may have leaked.

**Steps.**

1. Find the family's row in §6.6 and take its first move at once.
2. Run `pnpm fin rotate <env> <family> --emergency`: it follows the family's routine steps (§6.4) and
   drops the overlap where the family allows (caller keys, database logins, ingress proofs, the email
   token, R2 tokens, Better Stack tokens), accepting the outage the runbook names.
3. Confirm the new value works with the family's verification step, and that the old value is
   refused (a probe with the old value, where the issuer allows one).
4. Record `operator.credential_rotated` and the inventory change (§6.3).

**A Railway variable leak** (`docs/runbooks/railway-variable-leak.md`): assume every sealed variable
of the named services, or of every service, is known. Rotate in this order, recording each time:

| Order | Families | Why first |
|---|---|---|
| 1 | `tunnel-token` (both tunnels, §8.2) | an interception credential |
| 2 | `masspay-key` (trip `live_money` first), `sumsub-token`, `email-token` (revoke at the issuer) | each acts outside Fin at once |
| 3 | `caller-key`, `db-login`, `better-auth-secrets` (then end every session), `ingress-proof` | they act inside Fin |
| 4 | `seal-key`, `index-key`, `money-seal-key`, `money-index-key` (with re-seal) | dangerous only with a database copy; check `privileged-login` and the backup bucket's access first |
| 5 | `vault-token`, `telemetry-token`, `errors-dsn`, `heartbeat-url`, `turnstile-secret`, `google-client-secret` | lower impact |
| 6 | `api-key-pepper`, `limit-key`, `cursor-key` | within a week, routine order |

Then export Railway's audit log, read `deploy-outside-window` and `privileged-login` history for the
exposure window, and run the personal-data breach assessment if any step-4 family and a database
copy may both have leaked.

### 8.4 The restore check and the restore drill

Both prove that backups restore, that the restored data is the data Fin wrote, and that a restore
cannot undo a revocation ([DA-15], ARCHITECTURE §4.5, §15.3).

**The dump manifest** (written by `backup` beside each dump, in clear under [DA-11]'s ID-only field
allowlist): `backups/<nightly|hourly>/<yyyymmddThhmmssZ>.manifest.json` with `kind`, `startedAt`,
`endedAt`, `sha256`, `bytes`, `release`, `tables` (row counts by table), `auditHead` and `ledgerHead`
(`epoch`, `seq`, `hash`), and `restoreCanaryDigest`. The worker writes one row a day to
`ops.restore_canary (id, sealed_value, created_at)`: 32 random bytes sealed under the seal key in use;
the manifest records the SHA-256 of the newest row's sealed text (D08-26).

**The drill identity** (D08-16): dumps are encrypted to the escrow recipients and to a drill
recipient. The drill identity lives in the owner's password manager and is typed at the secure
prompt for each check or drill; it enters only the one-off task for that run. Its recipient is
rotated after each full drill through a reviewed change to the settings file. On staging the dumps,
and so the restore check and the full drill, wait until the owner gives CR-10 and the drill
recipient ([BD-14]); Railway's PITR and volume backups cover staging meanwhile.

**The restore check** (`docs/runbooks/restore-check.md`; weekly in production, monthly in staging;
heartbeat `restore-check`):

1. `pnpm fin restore-check <env>` registers the run and asks for the drill identity.
2. It creates a throwaway Postgres 18 service `fin-next-<env>-restore-check` on the private network
   (no domain, no proxy).
3. A one-off task on the backup image downloads the newest nightly dump and its manifest, checks the
   SHA-256, decrypts, and restores with the roles dump first.
4. Checks, each recorded pass or fail:
   - the full verifier (§3.8) over the restored `audit.event`, and its head equals an R2 anchor at
     the same `seq`, or extends the newest anchor at or below it;
   - the restored ledger head against the R2 ledger anchors the same way;
   - row counts within 1% of the manifest's `tables`;
   - the newest `ops.restore_canary` row's sealed text hashes to `restoreCanaryDigest`;
   - `pnpm fin restore replay <env> --dry-run --since <dump time>` against the copy lists every
     journal entry newer than the dump and finds each target in it.
5. It writes `ops/drills/<env>/<yyyy-mm-dd>-restore-check.json.age`, pings `restore-check` (or
   `/fail`), deletes the throwaway service and ends the task.
6. Target: under 60 minutes at staging's size; the time is recorded each run.

**The full drill** (`docs/runbooks/restore-drill.md`; monthly in production, quarterly in staging;
heartbeat `restore-drill`), timing each step against [P-14]'s RTO of 2 hours:

1. Register the drill; open the seal key from escrow with `pnpm fin escrow open <env> seal-key <n>
   --reason "restore drill" --drill`, which notifies instead of paging (D08-27).
2. Restore by PITR to a point 30 minutes back into a sibling service (Railway's PITR restore) (T1).
3. Enable PITR on the sibling (T2). Converting it to HA is not drilled monthly; SP-17 and PG-05 cover
   it once.
4. Start throwaway copies of `api` and `worker` at the running release's digests against the sibling,
   with `FIN_ENVIRONMENT=<env>-drill`, no public route, no email or provider token, and every kill
   switch on; prove `/readyz` refuses until the drill marker is complete (T3).
5. Write a drill marker under `ops/drills/` (never `ops/restore/`, so `audit-epochs` is not tripped),
   start the drill epoch on the sibling, and run the journal replay against it (T4).
6. Run the ledger walk and the orphan listing (spec 04 §20.3) on the sibling, read-only (T5).
7. Open the restore canary with the escrowed key inside the task (T6).
8. Write the report with every step's time; tear the sibling and the copies down; rotate the drill
   recipient (T7).

**Pass rule.** Every check passes; T7 minus the start is within [P-14]'s RTO (UNVERIFIED until the
first drill); the report exists; the heartbeat pinged. A failed drill is a SEV3 incident with its own
review.

### 8.5 The other playbooks

Each is a file in `docs/runbooks/` with §6.4's headings, written in H-05 and run once before
production (PG-05). Their first steps:

| Playbook | Trigger | First steps |
|---|---|---|
| `static-deployment-changed.md` | `static-deployment-changed` | remove any route or Worker the release does not name (`pnpm fin routes apply <env>`); on the shared staging zone that is only routes on fin-next's names and fin-next's own Workers, and a route on another name that matches one of fin-next's hosts is reported to the owner, never removed by `pnpm fin` ([FD-09], EX-27); re-render and re-upload the release's attested artefact with `tools/static-deploy` ([BD-16]: `pnpm fin static render <env> --release <sha>`, then `node tools/static-deploy/src/main.ts <env> --release <sha>`); revoke and re-mint the static deploy token; read Cloudflare's audit log; treat every credential typed into the changed page in the window as disclosed (end sessions, notify) |
| `railway-variable-leak.md` | a Railway notice, or a leak of any service's variables | §8.3 |
| `api-keys-leaked-at-scale.md` | `key-leaked` in bulk; a public dump | `live_keys` switch if live keys are involved; revoke the reported keys (`api`'s key-revoke door); email the organisations; consider rotating the pepper |
| `personal-data-exposure.md` | a scrubber miss found in Better Stack; a read beyond the budgets; any PD-2 or PD-3 seen outside its place | contain (switch, revoke, delete the lines in Better Stack with its deletion request), record the scope, start the 72-hour clock with counsel |
| `failover-lost-commits.md` | `failover-detected` with `audit-head-moved-back` | §3.9; then spec 04's ledger walk and orphan listing before money resumes |
| `email-outage.md` | `email-not-sent` P, `email-outbox-age` P | Cloudflare's status; the token's expiry and IP filter; staff sign in by passkey regardless (ARCHITECTURE §9.9); if [EM-03] built a second sender, switch it |
| `betterstack-outage.md` | Better Stack's status; every `no-logs` at once | lines stay on Railway's stdout; the watcher and the uptime monitors are also Better Stack's, so check Railway's own deploy emails and the status page by hand; no deploys until it returns |
| `cloudflare-outage.md` | Cloudflare's status | nothing reaches Fin; post on the status page (Better Stack hosts it); no action at Railway helps |
| `losing-railway.md` | Railway down past 4 hours with no estimate | ARCHITECTURE §15.4 ([OP-04]) |
| `owner-unreachable.md` | a P page unacknowledged past the escalation | the automatic trips stand; the responder's break-glass role if [OB-06] made one; otherwise the Cloudflare kill-switch rules by whoever holds the Cloudflare token |
| `builder-token-leak.md` | a builder or CI lane token seen | revoke it in GitHub; read the owner's security log; check `github-settings-changed` history; re-review merges in the window |

### 8.6 Kill switches as containment

ARCHITECTURE §15.1 and [OP-01] hold. The switches (rows of `ops.kill_switch`, read on every request
with no cache, guarded by §3.5's audit rule):

| Switch | Stops | Owner spec | Cloudflare rule for when Railway is down |
|---|---|---|---|
| `live_money` | every live money write | 04 §31 | `killswitch-money`: blocks `/v4/transfers*`, `/v4/customers/*/beneficiaries*`, `/v4/customers/*/virtual_account*` on `api.` |
| `provider_instance:<instance>` | money writes on one instance; tripped automatically | 04 §31 | as above |
| `live_keys` | every live API key | 05 §2.1 | `killswitch-api`: blocks all of `api.` except `/hooks/` |
| `signups` | account-creating sign-ins | 02 §5.1 | `killswitch-signups`: blocks the console's sign-up and code-send paths |
| `hosted_verify` | every verify door | 03 §18.4 | `killswitch-verify`: blocks the `verify.` and `selfie.` hosts whole |
| `outbound_webhooks` | developer webhook deliveries | 05 §5.4 | none (deliveries start inside Railway) |
| `sumsub_writes` | the transit queue, submit and uploads | 03 §7.4 | none |

There is no database switch for the whole public API: [OP-01] and ARCHITECTURE §15.1 list none, so
stopping all of `api.` is the Cloudflare rule `killswitch-api` alone, unless the owner first adds
such a switch to [OP-01]. The Cloudflare rules are WAF custom rules created disabled in hardening
(H-04, [OP-01]) and toggled by `pnpm fin killswitch <env> <rule> on|off` with the Cloudflare token
alone; a block answers Fin's JSON problem document. Each switch has a test that it stops what it
names and nothing else (T08-57), and each rule is toggled in a drill (§9). On the shared staging
zone, the Free plan's five custom rules hold `http-unsafe-block`, [BD-13]'s path rule and three of
these: `killswitch-api`, `killswitch-money` and `killswitch-signups` (spec 01 §7.6, ARCHITECTURE
§5.7). `killswitch-verify` and the monitors' WAF skip rule (§6.2 `monitor-header`) are production's
only.

---

## 9. Drills (H-12, for PG-05)

| Drill | Procedure | Measured | Pass rule |
|---|---|---|---|
| A rogue connector | run a connector with a staging token from outside Railway | time to the page | `tunnel-connectors` within 2 minutes (A08-20) |
| The evict swap under load | §8.2 steps 4 to 7 with a load test running | every step's time | no failed request; within 15 minutes of the decision |
| A static deployment changed | upload a throwaway file to a staging deployment outside `pnpm fin` | time to the page | `static-deployment-changed` within 2 minutes; the re-upload restores the manifest hash (A08-21) |
| Static deploy token leak | `static-deployment-changed.md` on staging | the steps' times | the old token refused; pages equal the release |
| Leaked email token | `rotate-email-token.md`'s leak section | outage length | the delivery check arrives with the new token |
| Railway variable leak | §8.3 as a tabletop, and the order's rotations on staging | each family's time | every family rotated once; no unexplained `audit-*` alert |
| Every rotation runbook | §6.4, once each, a database login among them | each time | each verification passes |
| Restore check and full drill | §8.4 | every step | §8.4's pass rule (A08-30, A08-31) |
| PITR and HA failover | SP-17 | RTO, lost range | services reconnect; the failover procedure of §3.9 runs |
| Journal replay | revoke a key, restore to before the revocation, replay | time | the key is revoked again before serving (A08-09) |
| An audit head overwrite | PUT a different body to an existing anchor key; try to delete it | | 412, and the lock refuses the delete |
| A chain tamper | as the superuser on staging, change one chained row's metadata | time to the page | `audit-chain-broken` at the next check (A08-07) |
| The sequencer stopped | stop the sequencer loop | time to the page | `audit-unsequenced` fires (A08-34) |
| The journal stopped | revoke the audit R2 token for 6 minutes | | `journal-unshipped` fires; the backlog ships after (A08-35) |
| A privileged login | log in as `fin_owner` outside a registered run | time to the page | `privileged-login` (A08-33) |
| Kill switches | each switch, and each Cloudflare rule with the Cloudflare token alone | time to effect | each stops what it names and nothing else (A08-32) |
| The pager | the daily canary for 7 days; the weekly test page | acknowledgement time | every canary arrives; the test page acknowledged within 15 minutes (A08-29) |
| Better Stack unreachable for one service | revoke one staging source token | | no request fails; `telemetry-gaps` reports the loss once the token is back |

---

## 10. Production gates: this area's evidence

EXECUTION §7.3 holds; these are this spec's parts of each gate.

| Gate | Evidence from security, audit and observability |
|---|---|
| PG-01 Cold review | `packages/audit`, the scrubbers, the relays, `ops/fin`'s security commands and the watcher reviewed cold with the attack pass, against §2.4's profiles; no open confirmed finding at medium or above |
| PG-02 Feature complete | every alert of §3.14 and §7.8 applied in production with its runbook file; every playbook of §8.5 written |
| PG-03 Test complete | every T08 test green; every A08 criterion met; T08-16's check passes for all 218 events |
| PG-04 Soaks | 7 days of the watcher green; 7 days of email with no unexplained `email.send_failed`; a week of the shadow count under the owner's number; 7 days with no unexplained `audit-*`, `telemetry-gaps` or `security-email-unsent` on staging |
| PG-05 Drills | every row of §9, with times recorded |
| PG-06 Performance | audited-write throughput and commit latency at [OP-08]'s launch capacity with synchronous replication on, the sequencer's lag under its threshold throughout; the relays' caps holding under a report flood; telemetry adding no measurable p95 to requests |
| PG-07 Data and legal | §5.2's table as the privacy notice's list; the erasure flow live; counsel's answers on audit retention, the 13-month context retention, the processor role and requests from people (§5.8); the breach clock in `incident-response.md` |
| PG-08 Supply chain and review integrity | the receipt-signing keys in the inventory; the hourly GitHub settings check live; the static manifest check live |
| PG-09 Monitoring and operations | production policies page; each responder's phone has had a test page; the responder gate of §7.9 met; the canary daily for 7 days; every heartbeat live; the incident, restore, losing-Railway and failure-mode documents reviewed; [OP-08]'s objectives set |
| PG-10 Production accounts | the production watcher in its watch account; the vault account with its own login; the `fin-production` team with no standing token online; production rows in `ops/credentials.json` complete |
| PG-11 Vendors | Better Stack's DPA and SOC 2 read; Email Sending's beta terms and token scope accepted in writing ([EM-02]) |
| PG-12 The old staging | not affected |
| PG-13 Owner's go | the stated limits of §2.5 and every open item of §15 put to the owner with the go |
| PG-14 Live money | the money alerts paging in production; `live_money` and `killswitch-money` drilled; the automatic trips tested; the ledger head anchored and verified daily for 7 days |

---

## 11. Lanes and file ownership

Paths are `tools/layout.json`'s; a lane edits only its own paths, and ownership moves through the lane
board at a merge point (EXECUTION §1.3).

| Lane | When | Owns | Delivers |
|---|---|---|---|
| Steward | Phase 0 onward | `docs/security/**` (`threat-model.md`, `threat-model.json`, `threat-model.schema.json`, `check.mjs`, `personal-data.md`, `personal-data.json`) | §2, §5.2's inventory; folds §14's decisions into DECISIONS.md and §15's reconciliations into the plan |
| P0-D | Phase 0 | `packages/core/src/{scrub,scrub-shapes,safe-error}.ts`, `packages/server/src/telemetry/**`, `packages/server/src/{report,report-dsn}.ts`, `packages/web-host/src/monitoring/**` | §5.4, §7.2, §7.3, §7.5's server client and relays; T08-30 to T08-35, T08-39 to T08-42 |
| P0-E | Phase 0, then Saturday | `packages/audit/{build,src}/**` except other areas' `src/events/<area>.ts`, `packages/db/migrations/<ts>_audit_*.sql`, `packages/db/roles/grants/audit.json`, `packages/db/src/guards/platform.ts`, `apps/api/src/worker/audit/**`, `apps/api/src/tasks/{audit-sync,audit-note,start-epoch}.ts` | §3.2 to §3.9, §3.14's duties; T08-01 to T08-13, T08-15, T08-16 |
| P0-G | Phase 0 | `packages/frame/src/report/**` (spec 06 §2.6's path) | §7.5's browser client |
| P0-F, then L-SAT-09, L-SUN-10, L-MON-09 | Phase 0 onward | `ops/monitoring/{check.ts,vrl/**}`, `ops/monitoring/catalog/{platform,audit,database,ops}.ts`, `ops/monitoring/<env>/{sources,errors,metrics,monitors,heartbeats,policies,webhooks,status-page}.json`, `ops/monitoring/<env>/alerts/{platform,audit,database,ops}.json`, `ops/monitoring/<env>/dashboards/**`, `ops/watcher/**`, `ops/credentials.json`, `ops/fin/src/commands/{monitoring,tunnel,secret,access}/**` (the Access commands are Phase 0 and Saturday work: `access apply` at EXECUTION §2.5 step 9, `access sync` and `revoke` with L-SAT-09, spec 02 §10.1), the runbooks of §3.14 and §7.8 for those fragments, and `docs/runbooks/evict-tunnel.md` (§8.2), Phase 0 work: written by EXECUTION §2.5 step 12 (Saturday 13:00) as the runbook of spec 01 §8.7's `tunnel-connectors` alert | §7.6 to §7.11, §6.5; T08-36 to T08-38, T08-43, T08-44 |
| L-SAT-05 | Saturday | `packages/email/src/{classes,digest}.ts`, `packages/email/src/templates/ops/**`, `ops/monitoring/catalog/email.ts`, `ops/monitoring/<env>/alerts/email.json`, `docs/runbooks/{email,security-email-unsent}.md` | §4.1 to §4.3, group G; T08-20 to T08-25 |
| H-04 | hardening | `ops/watcher/src/checks/{github,audit-epochs}.ts` (the `vault` check is Phase 0's, in P0-F's `ops/watcher/**`, EXECUTION §2.5 step 10), `ops/fin/src/commands/{logpush,killswitch}/**`, `ops/fin/src/commands/railway/audit-export.ts`, `apps/api/src/tasks/journal-replay.ts`, `ops/fin/src/commands/restore/replay.ts` | §3.10's replay, §3.13, §7.12, §8.6's Cloudflare rules; T08-14, T08-45 |
| H-05 | hardening | `ops/fin/src/commands/{rotate,escrow,restore,restore-check,reseal,reindex,sessions}/**` (the db tunnel's Access TCP application extends the Access commands through the lane board), `apps/api/src/tasks/{reseal,reindex,auth-reencrypt,sessions-end-all}.ts`, `docs/operations/**`, `docs/runbooks/{rotate-*,rotate-emergency,railway-variable-leak,restore-check,restore-drill,failover-lost-commits}.md` and §8.5's playbooks (the evict drill's times go into P0-F's `evict-tunnel.md` through the lane board) | §6.3, §6.4, §8 (§8.2's runbook is Phase 0's); T08-50, T08-51, T08-58 |
| H-06 | hardening | `ops/monitoring/production/**`, `apps/api/src/worker/canary/**`, the shadow copies | §7.9, §7.10, §7.13, §7.14; A08-29 |
| H-09 | hardening | `apps/api/src/worker/audit/context-sweep.ts` (moved from P0-E through the lane board), the erasure parts of spec 03 | §3.12's context sweep, §5.7 |
| H-12 | hardening | no files; drill records in the ops bucket; `docs/operations/drills.md` | §9 |

**The files this spec defines:**

```
docs/security/            threat-model.md, threat-model.json, threat-model.schema.json, check.mjs,
                          personal-data.md, personal-data.json
docs/operations/          incident-response.md, restore.md, losing-railway.md, failure-modes.md, drills.md
docs/runbooks/            evict-tunnel.md, rotate-<family>.md (one per row of §6.2), rotate-emergency.md,
                          railway-variable-leak.md, restore-check.md, restore-drill.md,
                          failover-lost-commits.md, the playbooks of §8.5, <runbook>.md per alert
packages/core/src/        scrub.ts, scrub-shapes.ts, safe-error.ts (+ tests)
packages/server/src/      telemetry/{lines,unit,batch,queue,ship,middleware}.ts, report.ts, report-dsn.ts
packages/web-host/src/    monitoring/{envelope,csp,buckets}.ts
packages/frame/src/       report/{client,queue}.ts (spec 06 §2.6)
packages/audit/           build/gen-index.ts; src/{define,record,chain,anchor,verify,journal}.ts;
                          src/events/platform.ts (area fragments beside it, owned by their lanes)
packages/db/              migrations/<ts>_audit_core.sql, <ts>_audit_journal.sql, <ts>_audit_guards_platform.sql;
                          roles/grants/audit.json; src/guards/platform.ts
apps/api/src/worker/      audit/{sequencer,anchor,check,journal-ship,context-sweep}.ts, canary/daily.ts,
                          ops/credential-check.ts
apps/api/src/tasks/       audit-sync.ts, audit-note.ts, start-epoch.ts, journal-replay.ts, reseal.ts,
                          reindex.ts, auth-reencrypt.ts, sessions-end-all.ts
ops/monitoring/           check.ts, catalog/*.ts, vrl/{logs,errors}.vrl, <env>/...
ops/watcher/src/          index.ts, ship.ts, checks/*.ts
ops/fin/src/commands/     monitoring/, tunnel/, secret/, rotate/, escrow/, restore/, restore-check/, reseal/,
                          reindex/, killswitch/, switch/, sessions/, access/, logpush/, railway/
ops/credentials.json
```

**Hand-overs.** H-04, H-05 and H-09 add the named files under `apps/api/src/tasks/` and
`apps/api/src/worker/audit/`, paths P0-E owns; P0-E hands each named file over at a merge point
through the lane board (EXECUTION §1.3). `docs/security/personal-data.*` stays the steward's; H-09
asks for its changes. Each area lane keeps its own fragments of `packages/audit/src/events/`,
`packages/email/src/templates/`, `ops/monitoring/catalog/` and `ops/monitoring/<env>/alerts/`.

**Definition of done** for a pull request in these paths: EXECUTION §1.5, with tier S review for every
path above except `docs/**` (tier D) and `packages/frame/src/report/**` (tier N, whose server side
is the relay).

---

## 12. Tests

The tests of §3.15, §4.5 and §7.15, and these:

| ID | Level | Statement |
|---|---|---|
| T08-50 | CI | `threat-model:check` passes on `main` and fails on each planted omission of §2.1's nine rules |
| T08-51 | CI | Every runbook named by an alert, an inventory row or §8 exists with §6.4's headings (MC-08, MC-10) |
| T08-52 | U | Each watcher check (`connectors`, `tunnel-config`, `dns`, `routes`, `static`, `rules`, `zone`, `access`, `email`, `railway`, `vault`, `github`, `audit-epochs`) fails on a planted difference in recorded fixtures of the providers' API answers, and passes on the clean fixture |
| T08-53 | STG | The evict drill (§9) completes with no failed request under load, times recorded |
| T08-54 | STG | A static deployment changed outside `pnpm fin` raises `static-deployment-changed` within 2 minutes |
| T08-55 | STG | SP-06's read-only token can read ingest tokens and heartbeat URLs (recorded); no standing production Better Stack token exists in any online store (`pnpm fin verify` lists the GitHub environments' secret names and the watcher's secret names) |
| T08-56 | STG | The restore check passes end to end (§8.4) |
| T08-57 | I, E2E | Each kill switch stops what it names and nothing else; each writes `switch.refused` lines and, when set, its audit event and journal entry |
| T08-58 | I | `sessions-end-all` ends every session of its realm, writes one `session.ended` per session with `reason: "security_incident"` and one `sessions_ended` journal entry |
| T08-59 | STG | A `fin_owner` login outside a registered run raises `privileged-login` |

---

## 13. Acceptance criteria

Labels as EXECUTION's: `[U]` unit, `[I]` integration on Postgres 18, `[E2E]` Playwright, `[STG]`
staging, `[CI]` a CI job.

| ID | Statement | Tests |
|---|---|---|
| A08-01 [CI] | `threat-model:check` passes, and fails on each planted omission | T08-50 |
| A08-02 [I] | The registry syncs, `audit.record()` refuses each bad input with its SQLSTATE, and each login role records exactly its events | T08-01 to T08-04 |
| A08-03 [CI] | Every one of the 218 events has a test that fails when it is not written | T08-16 |
| A08-04 [I] | Every guard registration is installed and refuses a commit without its event | T08-06 |
| A08-05 [I] | Audited writes never wait for each other; the chain is gapless; the TypeScript and SQL hashes agree | T08-09, T08-10 |
| A08-06 [STG] | Anchors reach R2 within 2 minutes of a write, `audit.head` lines reach Better Stack, and the hourly check is green for 24 hours | T08-11, T08-12 |
| A08-07 [STG] | A tampered chained row raises `audit-chain-broken` at the next check | §9 |
| A08-08 [I] [STG] | Each journal kind is written with its event, and shipped to R2 within a minute on staging | T08-13 |
| A08-09 [STG] | After a restore, a key revoked after the restore point is revoked again before any service is ready | T08-14, §9 |
| A08-10 [I] | No staff-scope row reaches an organisation's or a person's view; context rows exist only for console and Fin Admin actors | T08-08 |
| A08-11 [I] | Security notices fold into the digest past 5 an hour, bypass templates never fold, and none is dropped | T08-21, T08-25 |
| A08-12 [I] | `email.enqueue()` refuses every template outside each role's folders | T08-22 |
| A08-13 [U] | The scrubbers remove every shape and withheld name of §5.4 | T08-30, T08-32 |
| A08-14 [CI] | The public-safety check and gitleaks use `scrub-shapes.ts` and fail on each planted shape in a diff | T08-30 |
| A08-15 [STG] | A day of staging lines holds no email address, IP address, cookie or token shape (a saved exploration with the shapes returns no row) | T08-30 |
| A08-16 [CI] | `personal-data.json` covers every `_sealed` column and every table of §5.2 | T08-50 |
| A08-17 [CI] | `ops/credentials.json` is valid, and every runbook exists with its headings | T08-36, T08-51 |
| A08-18 [U] | `credential-check` warns at 30, 14 and 7 days and holds back a cadence heartbeat when a credential is overdue | T08-43 |
| A08-19 [STG] | Ingress proofs, a caller key, a database login and the email token are each rotated on staging with no failed request beyond the runbook's stated window | §9 |
| A08-20 [STG] | A rogue connector alerts within 2 minutes, and the blue and green evict completes with no failed request under load | T08-53 |
| A08-21 [STG] | A static deployment changed outside `pnpm fin` alerts within 2 minutes, and the re-upload restores the manifest hash | T08-54 |
| A08-22 [STG] | Every service's lines carry the deployed `release`, and each sampled unit has exactly one terminal line | T08-39 |
| A08-23 [STG] | A forced server error and a forced browser error in each app reach Errors with `release` and `environment`, with no address, cookie or query in the stored event | T08-33, T08-35, T08-42 |
| A08-24 [E2E] | Every journey runs with a `securitypolicyviolation` listener and fails on any violation; a forced violation on staging writes one `csp.report` line | T08-34 |
| A08-25 [CI] | `monitoring:check` fails on each planted MC case, and the apply script refuses each MA case | T08-36, T08-37 |
| A08-26 [STG] | After `pnpm fin monitoring apply staging`, the dry run shows no difference, every monitor is up and every heartbeat has pinged in its period | AC-P0-32 |
| A08-27 [STG] | A forced alert of each severity emails `staging-quiet`; no staging object calls, texts or pushes | T08-38 |
| A08-28 [STG] | The probe's `auditUnsequencedS` and `audit-unsequenced` work with the sequencer stopped | T08-44 |
| A08-29 (production, PG-09) | A test page reaches each responder by critical push and call; the canary arrives for 7 days running | §9 |
| A08-30 [STG] | The restore check passes end to end within its time target, with its report written. On staging it waits for CR-10 and the drill recipient ([BD-14]), and is not met until then | T08-56 |
| A08-31 [STG] | The full restore drill runs with every step timed and compared with [P-14]. On staging it waits for CR-10 and the drill recipient ([BD-14]), and is not met until then | §9 |
| A08-32 [STG] | Each kill switch, and each Cloudflare rule staging holds once hardening has made them (§8.6), stops what it names and nothing else | T08-57 |
| A08-33 [STG] | A privileged login outside a registered run alerts | T08-59 |
| A08-34 [STG] | `journal-unshipped` fires when the journal cannot ship, and the backlog ships afterwards | §9 |
| A08-35 [I] | `sessions-end-all` ends every session of its realm with its events and journal entry | T08-58 |
| A08-36 [STG] | Logpush records in Better Stack carry only the allowlisted fields (hardening) | T08-45 |

---

## 14. Decisions this spec makes

D08-02, D08-32 and D08-34 change register entries and are already settled in DECISIONS appendix C
(SF-10, SF-01). The steward copies the rest into DECISIONS.md as Recommended in a later pull
request of the plan.
Builders proceed on them.

| ID | Decision | Why |
|---|---|---|
| D08-01 | A sweep of expired rows writes one `system.sweep_completed` audit row per table per run that deleted anything | ARCHITECTURE §8.1 counts sweeps as system writes; one row per run keeps the trail bounded |
| D08-02 | The client address and user agent of [BC-03] live in `audit.event_context`, outside the chain, kept 13 months | personal data needs a retention the life-long chain cannot give |
| D08-03 | Audit metadata keys may be camelCase or snake_case as each area spec wrote them; new fragments use snake_case | specs 02 to 05 already differ; renaming would churn tests |
| D08-04 | Operator actions that change the database write `operator.*` events through `migrate --task audit-note`; when the database is unreachable the run registration is the record and the note follows | R9 covers the operator; the ops bucket is the fallback |
| D08-05 | A guard refusal by a direct login is visible only in Postgres's log (TM-L10) | a trigger cannot write a line that survives its own rollback |
| D08-06 | The sequencer runs every second but writes one `job.run` line a minute | 86,400 lines a day would be noise and cost |
| D08-07 | The epoch check runs in the watcher, against the restore and reset markers in the ops bucket | the database cannot vouch for its own epoch |
| D08-08 | `docs/security/personal-data.json`, checked against every `_sealed` column | the privacy notice must list every place |
| D08-09 | A new alert `pd-read-limit` (N) when an organisation meets its personal-data read limit | it is how a session harvesting details looks |
| D08-10 | `pnpm fin rotate` prepares the inventory's date change for a reviewed pull request | one source of truth, with a trail |
| D08-11 | Rotating the limit key counts under both versions for 24 hours and enforces the higher | a rotation must not hand out fresh allowances |
| D08-12 | Browsers use a placeholder DSN; each relay forwards to its sealed `FIN_BROWSER_ERRORS_DSN` | no Better Stack identifier in a public bundle or `env.json` |
| D08-13 | Every app's `_headers` adds `Reporting-Endpoints: csp="/api/monitoring/csp"` and `report-to csp` to the page policy, except the `docs` profile, which has no `/api/` and reports through spec 05 §8.13 | production violations must be seen (research D1 §9); amends ARCHITECTURE §7.12's string |
| D08-14 | No monitor carries an Access service token; the admin API's liveness rides on its lines | a service token would widen Access's policy |
| D08-15 | A second dashboard, "Fin Security" | security signals need one place |
| D08-16 | The drill identity is typed per check or drill; its recipient rotates after each full drill; the weekly check is operator-started | [DA-15] forbids a standing drill key |
| D08-17 | ID prefixes `aud` (audit event) and `jrn` (journal entry) join `packages/core/src/ids.ts` | ARCHITECTURE §6.2's list lacks them |
| D08-18 | SQLSTATE class `FA` for audit refusals (`FA001` to `FA005`, `FA010`) | callers and tests need stable codes |
| D08-19 | `audit.event_type` is upserted from `AUDIT_EVENTS` after each migration run and never loses a row | the allowlist must live where the database can enforce it |
| D08-20 | `ops.kill_switch` is a guarded table | a switch change is an important action |
| D08-21 | Journal kinds are declared on events and written by `recordAudit` | no caller can forget one |
| D08-22 | Email classes and the digest as §4.2 and §4.3 (5 security notices an hour per recipient, then an hourly digest; the bypass list) | makes [SA-41] buildable |
| D08-23 | One shape list (`scrub-shapes.ts`) for the scrubbers, the public-safety check and gitleaks | one list cannot drift |
| D08-24 | The daily canary is observed by the responder; heartbeat `canary-delivered` is pinged by the canary policy's webhook step (the limit this leaves is TM-L12, in the private annex) | the watcher holds no Better Stack token by design; amends ARCHITECTURE §10.6 |
| D08-25 | Logpush keeps only the path's first segment | redacts every token-bearing path by construction |
| D08-26 | A daily sealed restore canary row, and a dump manifest with row counts, heads and the canary's digest | a junk dump of the right size must fail the check |
| D08-27 | `pnpm fin escrow open --drill` notifies instead of paging | a monthly drill should not wake anyone |
| D08-28 | New commands: `pnpm fin tunnel status\|wait\|swap\|retire\|kill`, `sessions end-all`, `access revoke-sessions`, `restore-check`, `restore replay`, `monitoring report`, `monitoring rotate-source`, `logpush apply`, `railway audit-export`, `railway ping` | the runbooks need them |
| D08-29 | After a tunnel leak: end every session of the tunnel's realm, notify every organisation whose keys were used in the window, re-read provider state; a forced expiry of live keys is the owner's call at the incident | a rogue connector sees everything on its tunnel |
| D08-30 | The threat model's JSON shape and `threat-model:check`'s nine rules | ARCHITECTURE §7.14 named the check but not its rules |
| D08-31 | The weekly test page is a `canary.test_page` line and a P alert that must be acknowledged within 15 minutes | makes [OB-17]'s test page concrete |
| D08-32 | An Errors application `fin-next-<env>-docs-web`, fed only by the edge's docs reports | the docs site has no relay of its own |
| D08-33 | One catalogue of names: §3.4 is the canonical list of audit event names and fragment files, and §4.4 of template names and folders. They take the owning spec's names (spec 05's `api-keys.ts`, `webhooks.ts`, `key-changed`, `key-exposed`, `endpoint-changed` and `endpoint-paused`; spec 03's `customer.sandbox_reset` and `staff-kyc/` folder), and specs 02, 03 and 05 were edited to use them on 21 Nov 2026. No event name is also a permission key | `recordAudit` accepts only registry names and R9 needs one test per event, so two names for one event would break the joins and the tests or leave an event unwritten |
| D08-34 | `audit.record()` stores context only for `console` and `admin` actors | [BC-03] names those two; a customer's address on a hosted page is not Fin's to keep |
| D08-35 | The guard matches `target_id` or any of up to 32 `ref_ids` | reconciles spec 02's ten refs and spec 04's targets (its `target` and `refs`) |

---

## 15. Open items

| # | Item | Who | By |
|---|---|---|---|
| 1 | Closed: the owner decided [AU-01] at its default at the Saturday sitting (21 Nov, about 08:25, "defaults"): R9 means actions and disclosures, not a row per read | none | decided |
| 2 | [AU-03]: production's audit bucket lock, Indefinite by default | Owner | production |
| 3 | [OB-18] is decided: the owner took its default at the Saturday sitting (21 Nov, about 08:25, "defaults"), so the watcher stays a Worker. Still open: accepting the limit that D08-24 leaves (TM-L12, in the private annex). The daily canary is production's (§7.9, H-06), so nothing on staging waits on it; the steward folds D08-24's text into ARCHITECTURE §10.6 (item 6) | Owner | production |
| 4 | Names across specs (D08-33). Settled on 21 Nov: spec 02's `keys.ts` fragment and `keys/` folder are now `api-keys.ts` and `api-keys/`, its four `api-key-*` templates are now `api-keys/key-changed`, and its key metadata and revoke reasons defer to spec 05 §4.9 and §4.10; the roll overlap is `now`, `1h` or `24h` in the request and the audit row alike (spec 02 §12.3, spec 05 §4.10); the Sandbox reset is `customer.sandbox_reset` everywhere; the reveal-budget notice is `staff-kyc/reveal-budget`. Spec 03's webhook names already defer to spec 05 §5.7 (spec 03 §16.5). Spec 04 §7.7 and §28 now use §3.3's `target` and `refs` (the guard's matching is D08-35's) | none | done |
| 5 | Resolved on 21 Nov: spec 02 §18.4 and S2-35 now follow D08-14. Both admin monitors expect Access's own refusal, `admin-api-health` fails on any answer from the admin API half, and the watcher asserts the Access application's shape (`admin-access-shape`) | none | done |
| 6 | ARCHITECTURE §7.12's page policy lacks `report-to`, and §10.6's canary sentence: fold D08-13 and D08-24 into the plan. Spec 01 S0-10's alert names (`static-deployment-changed`, `cloudflare-config-changed`) are folded into ARCHITECTURE §5.9 and §10.8 before the first commit | Steward | a later pull request of the plan |
| 7 | Counsel ([DA-08]): audit for the life of the service, the 13-month context retention, the processor role, and how requests from people about their data are answered (§5.8) | Owner with counsel | production (PG-07) |
| 8 | SP-06: the DSN regex for `report-dsn.ts`; whether a source token can be regenerated; what a read-only token reads | Ops agent | Saturday morning |
| 9 | SP-11 and SP-13: Sumsub's and MassPay's credential shapes for `scrub-shapes.ts` | Sunday and Monday lanes | before their first merge |
| 10 | Logpush: the exact field names, and whether a Transformer can cut a path to its first segment; otherwise drop the path field entirely | H-04 | hardening |
| 11 | Railway's replica ID variable name for the `replica` field (SP-03) | P0-D | Saturday |
| 12 | The forced 72-hour expiry of live keys after a tunnel leak (D08-29): the owner confirms the default of deciding at the incident | Owner | production |
| 13 | [OB-06], [OB-07], [OB-09], [OB-12], [AU-05], [AU-06]: production's responders, log retention, status page, journey monitor, Better Stack's audit add-on and the Railway audit-log export credential | Owner | production |
| 14 | Research notes D1, D2 and D3 were all present and were used (D3 §3 for `ReportFailures`, D1 §9 for `report-to`); spec 03 was read from its assembled file | none | recorded |
