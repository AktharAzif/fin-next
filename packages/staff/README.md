# @fin/staff

Fin Admin's staff (spec 02 §6.4, §6.5, §8.3, §10, §16.4, §17.3; DECISIONS SA-04, SA-12 to SA-15,
SA-29, SA-39; lane L-SAT-04). The staff realm itself (Better Auth, the staff gate, the ceremonies,
redeeming an enrolment code) is `@fin/identity`'s; this package is everything Fin Admin's own
routes need on top of it.

## Using it

Built once per process inside `main()` (apps/admin/src/server/main.ts):

```ts
const realm = createRealm({ settings, db, clock, lines, docsOrigin, actions: [STAFF_ACTIONS] });
const deps = createStaffDeps({ realm, clock, lines, environment: settings.environment });
// a route, in the realm's unit of work:
await realm.run(context, async (tx) => {
  const who = await requireStaff(realm, request, context, { permission: "staff.add" });
  return addStaff(deps, tx, who, { email, roleKey });
});
```

- `requireStaff` reads the staff session through the realm on every request (the gate and the
  Access check of §10.5 run in the realm's hook), checks the same person again (the session's
  Access `sub` and the member's address against the verified token), the gate state the route may
  be reached at, and the route's permission, resolved from the member's role now. The read renews
  the session; its `Set-Cookie` values go to `setCookies`, which the API half copies onto every
  answer whose unit committed (§11.2). With no session, an Access identity the staff table does
  not list (or lists as removed) writes `staff.not_listed` (§18.1). `staffViewer` does the same.
- Every staff change takes the staff-change lock, reads the actor and the target again, applies
  §8.5's rules and the last-Admin rule (`409 last_top_role`), and only then asks for the intent
  (`who.stepUp`), which it spends in the same transaction as the change, its audit event, its
  revocation-journal entry and its notices.
- `staff.bootstrap_admin()` (migrations/*_staff_bootstrap.sql) is the first Admin's, called by
  `migrate --task staff-bootstrap` (apps/api/src/tasks/staff-bootstrap) as fin_owner.
- `runAccessDriftCheck` is the hourly drift duty's work; the worker wires it with
  `readAllowList` (FIN_ACCESS_READ_TOKEN) and `staffAccessList` (fin_worker's one staff grant).

## Layout

| Path | What |
|---|---|
| `src/require-staff.ts`, `src/step-up.ts` | the guard and the intent check of Fin Admin's routes |
| `src/members.ts`, `src/lock.ts` | add, change a role, remove, reset, new code, list; the lock and the last Admin |
| `src/custom-roles.ts`, `src/roles.ts` | custom staff roles (§10.7, stretch 3): make, save and delete through the access engine's editor validation, with intents, the version, the 30-role limit and the edit allowance; the role reads |
| `src/enrolment-codes.ts` | the code's format, hash and issuing (identity's realm redeems it) |
| `src/switches.ts`, `src/account.ts`, `src/viewer.ts` | the other routes' cores |
| `src/access-drift.ts` | the Access drift check |
| `src/audit/`, `src/email.ts`, `src/actions.ts`, `src/guards.ts` | the area's events, notices, step-up actions and guards |
| `migrations/`, `grants/` | the staff schema's tables, views and bootstrap function, in the runner's format |
| `test/` | the integration harness on the real platform, which tests import by its path (no package exports test support) |

## Tests

`pnpm --filter @fin/staff test` runs the unit tests; `pnpm --filter @fin/staff test:db` the
integration tests against `FIN_TEST_DATABASE_URL`: each file gets a fresh database bootstrapped by
`@fin/db`'s own test bootstrap and migrated by its runner with P0-E's, `@fin/identity`'s and this
package's migrations and grants (test/platform.mjs).
