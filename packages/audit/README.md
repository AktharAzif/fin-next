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
`audit.event_type` from it after each migration run, the journal kind included; a role missing from
`roles` is refused by the database with `FA002`.

A declared journal entry is written in the action's transaction. `journal.when` decides whether; the
database decides what it says: `audit.record_journal()` takes the kind from the event's type and the
organisation and subjects (the target, then the refs) from the event's own row, one entry per event.

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
and any string Postgres could not store (a lone surrogate) before any SQL, keeps at most 400
characters of a user agent (cut between characters), and on a database refusal writes
`audit.write_failed` (`auditEvent`, `sqlstate`) and throws `AuditWriteError`, so the action rolls back.
