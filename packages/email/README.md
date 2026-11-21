# @fin/email

Fin's email: `EmailPort` and the Cloudflare Email Sending adapter, the template classes and
templates, the outbox store and the one sender (ARCHITECTURE §9; spec 08 §4; spec 01 §6.10, §8.5).
Only `worker` sends ([EM-04]); every other service calls `email.enqueue()` in its own transaction.

## Layout

| Path | What |
|---|---|
| `src/classes.ts` | The five classes (`code`, `security`, `notice`, `customer`, `ops`), their subdomain, priority and allowance rule; `defineTemplate` |
| `src/params.ts` | The parameter vocabulary: Fin IDs and the allowed display values (T08-23). A value Fin builds refuses secret shapes; a value someone else chooses (`personName`, `orgName`, `roleLabel`, and `device` from the user agent) never refuses a string, and shows "(not shown)" in place of one that is not a clean label or holds a secret shape, so no chosen name can refuse a notice and with it the action. Names are also checked against the enrolment and backup codes' shapes, so a code passed into a name by mistake is hidden, never mailed (T08-23); a name in a code's shape ("Tier1-Admin") shows "(not shown)" too |
| `src/render.ts` | The one lean layout: text and HTML, typed values only in labelled boxes, at most one link, no image |
| `src/templates/<folder>/<name>.ts` | One file per template; each folder belongs to its area's lane (spec 08 §4.4) |
| `src/catalogue.ts` | Every template, and `email.enqueue()`'s per-role allowlist generated from the folders |
| `src/headers.ts` | Cloudflare's header allowlist, checked in code, and Fin's three headers |
| `src/providers/cloudflare/` | The REST adapter and its host allowlist |
| `src/outbox/` | The database seam and every statement the sender runs; `enqueue()` checks the params against the template before the row is written, so a notice that could never be sent fails the caller's transaction |
| `src/sender/` | The sender: claims, leases, limits, the digest, the bucket, budgets and retries |
| `src/testing/` | A fake transport, a line recorder and the integration-test database helper |
| `migrations/20261121121000_email_sender.sql` | This lane's extension of the outbox, which `migrate` applies after P0-E's `<ts>_email_outbox.sql` (the database files' rule, `packages/db/src/assets.ts`) |
| `grants/email-sender.json` | Its grants, beside P0-E's `email` fragment (`packages/db/roles/grants/email.json`); the template grants are not here but in `src/catalogue.ts`, which `migrate` syncs into `email.template_grant` after every run |
| `test/fixture/outbox-base.sql` | A test-only stand-in for P0-E's `<ts>_email_outbox.sql` (spec 01 §6.10), with its seeded `ops/delivery-check` grant, and for the one `ops` table the delivery check writes (`ops.duty_state`) |

## Adding a template (area lanes)

1. Add `src/templates/<folder>/<name>.ts` with `defineTemplate({ ... })`: the class fixes the
   subdomain; a `security` template needs its `digestLine`; a `code` template its `codeTtlMs`.
   Subject, heading and preview are fixed words; typed values go only in `boxes`.
2. Add it to `TEMPLATES` in `src/catalogue.ts`. The role allowlist follows from the folder, and
   the next `migrate` run writes its rows to `email.template_grant` (no migration is needed). A
   worker still on an older release keeps a row whose template or params it does not know and
   tries it again every 5 minutes, so a newer replica sends it; it never deletes it at once.
   Narrowing a role's rule needs no migration either: the next run deletes the role's rows for the
   templates the catalogue holds. Taking a template out of `TEMPLATES` leaves its rows, since a
   release still running beside the new one may queue it; a later migration deletes them.
3. `pnpm --filter @fin/email test` renders it with its `sample` and checks the rules (T08-20,
   T08-23); the integration test proves `email.enqueue()` allows it only for its roles (T08-22).

## Tests

- `pnpm --filter @fin/email test`: unit tests (templates, adapter against a fake fetch, units).
- `pnpm --filter @fin/email test:db` with `FIN_TEST_DATABASE_URL` naming a Postgres 18 database the
  login may create databases and roles in: the sender as the worker's own login.
