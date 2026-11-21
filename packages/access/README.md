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
(`roleNameKey`, for `name_taken`) is the engine's alone: look-alike letters of every script
Unicode's confusables data lists (Lisu "ꓮꓓꓟꓲꓠ" is "ADMIN"), Latin letters named for another
("ȡ", D WITH CURL, is d), letters drawn as punctuation ("Adminꞏ" is "Admin·"), digits, signs,
symbols and spacing marks drawn as letters ("Adm1n", "0perator", "⍺dmin"), letter pairs drawn as
one ("rn", "cl", and "cI" or "c1" as well), I and l, and invisible characters do not make a name
different. A name is read as stored and as drawn on a left-to-right and a right-to-left line, where
a run of right-to-left letters is drawn reversed, and two names are the same when they are alike in
one of these orders. A letter that is not an ASCII one may stand for one letter in four of a
built-in's name, whatever it reads as, as a letter of no Latin reading may.

## Look-alike data

`src/engine/unicode-look-alikes.ts` holds rows derived from Unicode's confusables data (UTS #39,
`confusables.txt` 18.0.0) and from the names of the Latin letters (`UnicodeData.txt` 18.0.0), for
the characters Node 26's Unicode (17.0) assigns, and `src/engine/role-editor.ts` holds the
hand-made rows, which take precedence (small capitals, the case-insensitive readings of Cyrillic
and Greek, Coptic alfa, the clicks). The members of each of Unicode's classes read alike. The
reading folds case, so a small letter drawn as no Latin letter reads as its capital does, and a
capital reads as its small letter only when Unicode draws it so: a capital drawn otherwise (Greek
Γ, Armenian Ա) reads as no Latin letter. `src/engine/drawn-order.ts` holds the characters written
right to left (`DerivedBidiClass.txt` 18.0.0) and the order a line draws a name in.

`src/test-support/confusables.ts` commits every entry of Unicode's file but those whose source is
ASCII or draws as nothing, and `src/test-support/latin-letters.ts` the Latin letters compatibility
folding leaves as they are, with their names. `src/engine/look-alikes.test.ts` fails when an entry
does not read as its prototype is drawn, when two members of a class read differently, when a
capital reads as its small letter though Unicode does not draw it so, when a letter named for a
Latin letter (with a stroke, hook, curl or tail, a form of it such as insular or script, or a small
capital) does not read as it, when a derived row is not one the data asks for, or when the
runtime's Unicode is newer than the data. `src/engine/drawn-order.test.ts` holds the
right-to-left characters to the runtime's scripts. To refresh for a newer file, replace the data
the same way and add or change the rows each failing test names. These files carry Unicode's data
under the Unicode License v3, whose notice the rows file holds.

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

`pnpm --filter @fin/access test` runs the unit, table and property tests, and holds the look-alike
rows to Unicode's data (`src/engine/look-alikes.test.ts`). The property tests
(T-SAT-08 in `src/engine/giving.test.ts`, and others) use the seeded generator in
`src/test-support/seeded.ts`. Set `FIN_PROPERTY_SEED` to replay a seed and `FIN_PROPERTY_RUNS` to
widen a run. Every failure message names its seed.
