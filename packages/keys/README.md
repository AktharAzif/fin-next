# @fin/keys

API keys (spec 05 §4; spec 02 §12, §13.5; ARCHITECTURE §7.7; DECISIONS SA-18 to SA-21, BC-05,
MO-20; lane L-SAT-11): the key's format and per-deployment checksum salts, scopes bounded by the
maker's role, address allowlists, the stored HMAC and its pepper chain, the lifecycle the console's
API half calls, the edge's check and its statements, the audit and email adapters, and the step-up
actions.

## The key

`fin_<test|live>_<sk|rk>_` + a 10-character Crockford key ID + a 32-character base62 secret + a
6-character base62 CRC-32 checksum over `salt + ":" + body` (`format.ts`). The salt is public and per
deployment (`fin-dev-1`, `fin-ci-1`, `fin-stg-1`, `fin-prod-1`; `salts.ts`): a staging edge refuses a
production key before any lookup. Only `HMAC-SHA256(pepper_v, body)` is stored, and a newer pepper is
applied over the stored hash (`hash.ts`, `pepper_versions` oldest first). The repository never holds
a key whose checksum verifies under a known salt: `scripts/check-key-shapes.ts` runs over every
tracked file in this package's unit tests (T05-03). `@fin/keys/format` is browser-safe.

## Using it

The console's API half (`apps/console/src/server/keys.ts`) runs `requireActor`, then:

```ts
const keys = createKeys({ clock, peppers, salt, lines });   // once, inside main()
await createKey(keys, tx, actor, { name, mode, kind, scopes, ipAllowlist, expiresIn });
await updateKey(keys, tx, actor, keyId, { name, scopes, expiresAt, ipAllowlist });
await rollKey(keys, tx, actor, keyId, { overlap: "1h" });
await revokeKey(keys, tx, actor, keyId);
```

Each checks the permission of the key's mode, the actor's role bounding a key they make, roll or
re-point with an allowlist change, its own rules (scopes only narrow, expiry only shortens, at most
50 working keys), then calls `actor.confirm()` (the step-up intent bound to the action, the key and
its fields), then writes the change, its `api_key.*` event (the fragment
`packages/audit/src/events/api-keys.ts`) and the `api-keys/key-changed` notice to every member, in
the caller's unit of work. A rolled key's maker is whoever rolled it. `rollForMember` and
`keysOfMember` are the credential source a removal or demotion rolls (spec 02 §9.4): every key the
member made or was shown that the edge still accepts, an old key inside a roll's overlap included,
whose overlap the removal cuts. `listKeys` pages a mode's keys, those the edge still accepts first.

The edge (`apps/edge`) runs `precheck` (shape and checksum, no I/O), `keyStore(db).lookup` (the one
statement on `keys.key_lookup`, the refused-key window and the `live_keys` switch), `judgeKey` (the
constant-time compare across the pepper chain, revoked, expired, the allowlist) and `liveGate`.

## Settings

`FIN_KEY_SALT` (this environment's salt) and `API_KEY_PEPPER_<n>` with `API_KEY_PEPPER_IN_USE`
(`keySettingsFromEnv`), on the edge, the console and the worker only.

## Layout

| Path | What |
|---|---|
| `src/format.ts`, `crc32.ts`, `base62.ts`, `crockford.ts`, `salts.ts` | the key's format, browser-safe |
| `src/scopes.ts`, `allowlist.ts`, `names.ts` | scopes and what the maker must hold, allowlists, a key's name |
| `src/hash.ts`, `generate.ts` | the stored hash and its pepper chain; making a key |
| `src/lifecycle.ts`, `audit.ts`, `email.ts`, `step-up.ts` | the console's actions, their events, notices and intents |
| `src/verify.ts`, `lookup.ts` | the edge's check and its statements |
| `migrations/`, `grants/keys.json` | schema `keys`, its view, `touch_last_used()`, the audit guard and the grants |
| `test/platform.mjs` | the Postgres 18 platform: P0-E's, identity's, orgs' and this package's migrations and grants |

## Tests

`pnpm --filter @fin/keys test` runs the unit tests (T05-01 to T05-06); `pnpm --filter @fin/keys
test:db` the integration tests against `FIN_TEST_DATABASE_URL` (the lifecycle, the grants, the audit
guard, "last used" and the edge's statement).
