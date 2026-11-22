# @fin/orgs

Organisations, members, invitations and custom roles, and the console's guards (spec 02 §9, §13.2,
§14.1; DECISIONS SA-10, SA-11, SA-32, SA-33, SA-34, BC-06), on the developer realm of
`@fin/identity` and the permission engine of `@fin/access`. Fin owns these tables and this code;
Better Auth's organisation plugin is not used ([SA-10]).

## Using it

`createOrgs(realm)` is called once per process inside `main()`, after `createRealm()` was given this
area's step-up actions (`actions: [ORGS_ACTIONS]`). A route runs its guard and its action in one unit
of work:

```ts
await realm.run(context, async (tx, state) => {
  const actor = await requireActor(realm, request, context, tx, state, {
    permission: "member.role",
    lock: true, // the team-change lock (§9.5)
    stepUp: { kind: "intent", action: "member.role" },
  });
  return changeMemberRole(orgs, tx, actor, memberId, { roleKey, rollCredentials });
});
```

- `personGuard` reads the session (and its refresh cookie), applies the gate of §6.2 to the route's
  reach, and returns the person with `confirm()`. `requireActor` adds `Fin-Organization` (never the
  session's current organisation, S2-10), the membership and the role's permissions, read now.
- Every action checks the session, the membership, the permission, then its own rules inside the
  lock (outrank, giving, last holder, input), and only then calls `confirm()`, which asks for the
  intent (`403 step_up_required`, the new intent committed) or checks and consumes it (S2-31).
- Each action writes its audit events (`audit/events.ts`, the `orgs.ts` fragment of spec 08 §3.4)
  and queues its notices (`orgs/` templates of packages/email) in the same transaction; a notice
  that cannot be queued rolls the action back ([SA-41]).
- Credential sources (API keys with stretch 1, webhook secrets on Sunday) register with the
  `CredentialRegistry` the console passes to `createOrgs` (§9.4, IF-07).

## Layout

| Path | What |
|---|---|
| `src/guard.ts`, `src/intents.ts` | `personGuard`, `requireActor`, intents bound to an organisation |
| `src/organizations.ts`, `members.ts`, `invitations.ts`, `custom-roles.ts` | the actions of §9 and §8.4 |
| `src/rules.ts`, `src/store.ts` | §8.5's rules inside the lock; the tables' reads |
| `src/audit/`, `src/email.ts`, `src/limits.ts` | the event fragment and its adapter, notices, §5.6's limits |
| `src/audit-log.ts` | the organisation's audit log and the person's activity (§14.5) |
| `src/guards.ts` | the audit-guard registrations the `_orgs_guards` migration installs |
| `migrations/` | `_orgs_tables`, `_orgs_views` (views and the two audit reads), `_orgs_guards` |
| `grants/orgs.json` | the area's grants, in packages/db's fragment shape |
| `test/` | the Postgres 18 template (identity's platform fixture, both areas' migrations and grants, the journal stand-in) and the realm harness, exported as `@fin/orgs/testing` |

## Tests

`pnpm --filter @fin/orgs test` runs the unit tests; `pnpm --filter @fin/orgs test:db` the integration
tests against `FIN_TEST_DATABASE_URL` (a Postgres 18 server whose role may create databases and
roles; the password from the URL or `PGPASSWORD`). The databases and roles are named `l_sat_03_*`.
