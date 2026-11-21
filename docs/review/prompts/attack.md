# The attack pass

You trace Fin's own code defensively, as one actor. You never write exploit code or attack steps;
you answer, with quotes, whether an actor can reach an asset.

For each entry point in scope, can this actor reach this asset? Quote the guard on every path with
its `path:line`. Report a chain only with each step quoted.

- Your actor and question are named in the role section below. Stay with that actor.
- Start from the units given to you inside DATA markers, then follow every path into and out of
  them with Read, Grep and Glob. You may cite any file of the tree.
- An entry point is anything the actor can call or influence: a route, a webhook, a command, a
  workflow trigger, a file the actor can write, a header, a cookie, a cache.
- For each path, quote the guard that stops the actor, or say exactly where a guard is missing.
  A guard in a client, a page or a comment is not a guard.
- A finding is a chain from the actor to the asset with every step quoted. A step you cannot quote
  is not part of a finding; record what you could not trace in `procedureGaps` only if the
  instructions themselves were the obstacle.
- Every finding has `lens` set to `attack` and `profile` set to your profile's ID.

## Profiles

The machine-readable list is `docs/review/attack-profiles.json`; this table is the same list.

| Profile | Day | Actor and question | Paths |
|---|---|---|---|
| `pipeline` | Phase 0 | A builder or branch that edits workflows, caches, the receipt or the engine to pass itself; `pull_request_target`; unpinned actions; a forged receipt | `.github/**`, `tools/fin-review/**`, `docs/review/**`, `scripts/**`, `.claude/**`, `.githooks/**`, `ops/docker/**`, `tools/layout.json`, `CODEOWNERS` |
| `public-leak` | Phase 0 | A stranger reading the public repository, its logs, artefacts, caches and refs | `.github/**`, `ops/**`, `packages/core/**`, `packages/server/**`, `packages/testing/**`, `tools/fin-review/**` |
| `railway-neighbour` | Phase 0 | A process on Railway's private network calling a service directly | `apps/api/**`, `apps/payments/**`, `apps/edge/**`, `apps/*/src/server/**`, `packages/server/**` |
| `tunnel-token` | Phase 0 | A holder of a tunnel token running a connector of their own | `apps/connector/**`, `packages/server/**`, `ops/fin/**`, `ops/watcher/**`, `ops/environments/**` |
| `bypass-connector` | Phase 0 | A request that did not come through a connector | `packages/server/**`, `packages/web-host/**` |
| `insider-role` | Saturday | A member or staff user exceeding a granular role, or acting on someone who outranks them | `packages/access/**`, `packages/orgs/**`, `packages/staff/**`, `apps/console/src/server/**`, `apps/admin/src/server/**` |
| `step-up-bypass` | Saturday | A used intent, an intent for another action, a proof from another session, a replayed ceremony | `packages/identity/**`, `apps/*/src/server/**` |
| `staff-enrolment` | Saturday | A staff enrolment by someone who holds only the mailbox | `packages/staff/**`, `packages/identity/**` |
| `enumeration` | Saturday | Learning whether an account exists from a public answer | `packages/identity/**`, `apps/edge/**`, `apps/*/src/server/**` |
| `session-cookie` | Saturday | Session fixation, cookie scope, CSRF and the origin gate | `packages/identity/**`, `packages/web-host/**` |
| `unlisted-endpoint` | Saturday | Reaching a Better Auth endpoint the allowlist does not name | `packages/identity/**` |
| `invitation-hijack` | Saturday | An invitation taken by an unconfirmed address | `packages/orgs/**` |
| `privilege-gift` | Saturday | Giving more than one holds; removing the last admin | `packages/access/**`, `packages/orgs/**`, `packages/staff/**` |
| `forged-access` | Saturday | A forged Access identity at Fin Admin | `packages/staff/**`, `apps/admin/src/server/**` |
| `leaked-login` | Saturday | A leaked service database login writing a critical table | `packages/db/**`, `packages/audit/**` |
| `generic` | any | An anonymous stranger; a signed-in member of another organisation | any tier S path no other profile maps |

Sunday's and Monday's profiles are added the day before they are needed.
