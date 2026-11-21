# @fin/audit

The audit trail (spec 08 §3; ARCHITECTURE §8; DECISIONS AU-01 to AU-04; lane P0-E): the event registry,
`recordAudit`, the chain hash and the verifier's walk, the registry sync, the sequencer loop and the
automatic switch trips. The tables and functions are `@fin/db`'s migrations.

## Declaring events (every area's lane)

Each area declares its events in `src/events/<area>.ts`, the file named after the area:

```ts
export const events = defineEvents("orgs", {
  "member.removed": {
    category: "team",
    scope: "organisation",
    roles: ["fin_console"],              // the login groups audit.record() lets record it
    actors: ["user"],                    // the actor kinds recordAudit accepts
    target: "mem",                       // a three-letter ID prefix is enforced; a longer word is a label
    metadata: z.object({ roleKey: z.string() }).strict(), // flat values only
    journal: { kind: "member_removed" }, // written in the same transaction (§3.10)
  },
});
```

`pnpm --filter @fin/audit gen` builds `src/events/_index.gen.ts` (git-ignored) from every fragment;
every package script that needs it runs the generator first. The `migrate` service syncs
`audit.event_type` from it after each migration run; a role missing from `roles` is refused by the
database with `FA002`.

## Recording

```ts
await recordAudit(tx, {
  event: "member.removed",
  actor: { kind: "user", id: userId, via: "console" },
  target: memberId,
  organizationId,
  metadata: { roleKey },
});
```

It runs inside the action's unit of work (`UnitTx`), refuses personal or secret shapes in metadata
before any SQL, and on a database refusal writes `audit.write_failed` and throws `AuditWriteError`, so
the action rolls back.
