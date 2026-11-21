# @fin/access

The permission engine and both permission catalogues (spec 02 §8; DECISIONS SA-11, SA-12, SA-16,
SA-32). One engine, two catalogues: `dashboardCatalogue` (26 permissions, built-in Super admin and
Admin) and `staffCatalogue` (26 permissions, prebuilt Viewer, Compliance, Operator and Admin).

The package is pure and browser-safe. It imports no `node:*` module and no other package, and it
never reads the clock, makes a random value or does I/O. `tsconfig.engine.json` compiles it without
Node's or the DOM's types, and `src/purity.test.ts` checks its imports and globals in the code
itself, template interpolations included (its scanner fails rather than skip what it cannot read).
Both apps' API halves and both single-page apps import it.

## The rules it holds

- Checks are by permission, never by role. A role Fin does not know, or a custom role that no longer
  exists, allows nothing. A permission name the catalogue does not define is never held.
- `permissionsOf` reads a custom role so that it fails closed. It drops unknown names, restricted
  permissions and any permission whose needs the role does not also hold.
- Who may act on whom (§8.5), checked inside the team-change or staff-change lock after both roles
  are read again:

| Function | Answers | The route refuses with |
|---|---|---|
| `givingProblem` | `unknown_role`, `gone`, `self`, `top_only`, `beyond`, `outranked`, `unchanged` | `403 outranked` for `outranked`; otherwise `403 giving_refused` with `problem` |
| `actingProblem` (remove, reset, resend, cancel) | `self`, `outranked` | `403 giving_refused` (`self`) or `403 outranked` |
| `lastTopRoleProblem` | `last_top_role` | `409 last_top_role` |
| `editingProblem`, `deletionProblem` (§8.4) | `gone` (the role itself), `built_in`, `self`, `outranked`, `move_required`, `move_forbidden`, `move_gone` (the role to move to was deleted meanwhile), or another giving problem for `moveTo` | `404 not_found` for `gone` only; otherwise `403` (`move_gone` is `403 giving_refused` with `problem: gone`) |
| `validateRole` (§8.4) | `name`, `name_taken`, `reads_as_built_in`, `description`, `empty`, `restricted`, `beyond`, `missing_need` | `400 invalid`, or `403 giving_refused` for `beyond` |

- Pass the role to give as `resolveRole` answers it. A reference built by hand with a built-in key
  or custom ID the catalogue does not define is `unknown_role` (and `gone` when it is edited); a
  typed catalogue takes only its own built-in keys as the role to give.
- Counts are read inside the lock and fail closed. `lastTopRoleProblem` takes `otherTopHolders`:
  the members other than the target who hold the top role (the organisation's other Super admins,
  or the other `active` staff Admins; a pending staff member is never counted). So the one active
  Admin may remove, demote or reset a pending Admin, and a count that is not a whole number reads
  as none. `deletionProblem` treats any holder or invitation count other than exactly 0 as someone,
  and `customRoleLimitReached` refuses any count that is not a whole number of at least zero.

The server passes `packages/identity/src/names.ts`'s `roleName` and `roleDescription` to
`validateRole` as `options.names`. The engine's own floor covers length, words, normalisation and
characters that draw as nothing (`\p{C}`, the default-ignorable characters such as the Hangul
fillers and variation selectors, and the blank symbols; `src/engine/text.ts`). Comparing a name
with the built-in roles' (`readsAsBuiltIn`) and with the realm's other custom roles
(`roleNameKey`, for `name_taken`) is the engine's alone: look-alike letters of Latin and other
scripts, digits and signs drawn as letters ("Adm1n", "0perator"), letter pairs drawn as one
("rn"), I and l, and invisible characters do not make a name different.

## On a screen

```ts
import { can, dashboardCatalogue, disabledReason, permissionSet } from "@fin/access";

const held = permissionSet(dashboardCatalogue, viewer.permissions); // unknown names dropped
can(held, "member.invite"); // a misspelt or a staff permission does not type-check
disabledReason(held, { allOf: ["member.role"] }); // null, or "Your role doesn't allow this. ..."
```

`visibleItems` and `visibleGroups` filter navigation trees (§8.7). Leave `requires` out for an item
everyone may open; a requirement that names no permission (`{}`, an empty `allOf` or `anyOf`) is
met by nothing, and so is `canAll` of an empty list. The role editor uses `tick`, `untick`,
`missingNeed`, `describePermissions` and `validateRole`.

## Catalogue fragments

Each area's permissions are one fragment, `src/catalogue/{dashboard,staff}/<area>.ts`. Each
catalogue's `index.ts` lists the fragments in the role editor's order. `assembleCatalogue` checks
the result when the module loads: keys and labels present and unique (permission keys also
ignoring case, and group, permission and built-in role labels ignoring case), needs known and
acyclic, built-in roles closed under needs, only the top role holding restricted permissions, and
the top role holding everything. A need that names an unknown permission is also a type error.
`src/catalogue/catalogue.test.ts` (T-SAT-09) compares both catalogues with spec 02's tables.

## Tests

`pnpm --filter @fin/access test` runs the unit, table and property tests. The property tests
(T-SAT-08 in `src/engine/giving.test.ts`, and others) use the seeded generator in
`src/test-support/seeded.ts`. Set `FIN_PROPERTY_SEED` to replay a seed and `FIN_PROPERTY_RUNS` to
widen a run. Every failure message names its seed.
