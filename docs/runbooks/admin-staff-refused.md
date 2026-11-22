# Access let in someone Fin Admin does not list

Alert: `admin-staff-refused` (pages: any `staff.not_listed` on admin).

## What it means

Fin Admin has two doors (spec 02 §10.1, F6): Cloudflare Access in front of the whole staff host,
then the staff table behind it. Adding someone is two acts in a fixed order (the Access list, then
Fin Admin) and removing is the reverse. Here a request passed Access with an identity that is no
active or pending member: Access let in someone the staff table does not know, or knows as removed.
The line's `reason` says where: `code_request` when that identity asked for a sign-in code (the
staff realm answers as if it sent one and sends nothing), `request` when it called a guarded route
with no live staff session (refused as signed out). Nothing was let through, and the line carries
no address.

A listed member who is merely signed out writes nothing. On staging the Allow policy covers the
company's address domain with One-time PIN (the owner's decision of 21 Nov), so a colleague who is
not staff and opens the staff host writes this line too.

## First check

Find who by IDs only; the line never names the address.

1. The request lines on admin with the same `requestId`: the `route`, the `cfRay`, and the time.
   Zero Trust's Access authentication logs around that time name the identities Access let in to
   the staff host.
2. That identity against the staff table: never added, or removed? A member removed in Fin Admin
   whose Access entry is still there is the second act of a removal not done yet.
3. Whether the Access policy changed: the last `pnpm fin access apply` run in the run log, and
   Cloudflare's audit log for Access changes no registered run explains.
4. How many: one identity once is a person trying the host; many lines, or many identities, is
   the Access list wider than it should be.

## Containment

1. A removal half done: finish it. Remove the address from the overlay's `access.staff`, run
   `pnpm fin access apply staging` (see `access-apply.md`), then revoke their Access sessions in
   Zero Trust.
2. Someone about to be added: nothing is wrong yet, but the order is the Access list first and Fin
   Admin second; add them in Fin Admin, or remove the Access entry until they are.
3. An Access change no registered run explains: someone else changed Fin Admin's outer door. Put
   the policy back with `pnpm fin access apply staging` and treat the Cloudflare operator token as
   exposed (`rotate-cloudflare-operator-token.md`).
4. Close it when no new line comes. The incident closes within about three minutes of the last
   line, and a later line opens a new incident with its own email, so a colleague's visit never
   hides another identity's: work through each incident on its own.

## When to wake the owner

At once for an Access change nobody can explain, or for repeated lines from one identity that is
not staff. On staging, a colleague under the company domain opening the host once can wait for
working hours.
