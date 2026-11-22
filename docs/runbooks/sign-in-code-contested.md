# Sign-in codes for one account contested above its threshold

Alert: `sign-in-code-contested` (notify only: `auth.code_contested` on console for one `userId`
above `@thresholds.sign-in-code-contested` in an hour).

## What it means

A developer signs in with an 8-digit code emailed to them, and there is one live code per address
(spec 02 §5.2, F3). So that a stranger who knows an address cannot keep cancelling its owner's code,
a browser the account does not know (no `known_browser` cookie for it, and not the browser that
asked the live code) is held back twice, and each time the console writes `auth.code_contested`:

- `reason` `supersede_refused`: it asked for a code while a known browser's code was live. It got
  the ordinary answer, nothing was sent, and the owner's code stayed live.
- `reason` `unknown_share_used`: it asked after browsers that are not known had used their share of
  the address's code emails (3 an hour, 8 a day of the 5 and 12). It got the ordinary answer and
  nothing was sent; the rest of the allowance stays for known browsers.

The line carries the account's `userId` when the address has an account, and never the address,
the browser or the code. The alert counts per `userId`, so one incident is one account. Lines for
an address with no account carry no `userId` and share one series with an empty label: one person
asking codes for many addresses that have no account.

Nobody was signed in by a contest, and the owner can still sign in: with their own browser's code,
or with a passkey whatever happens here. Many contests for one account mean someone is asking codes
for it from browsers it does not know, trying to cancel its owner's code or to use up its code
emails, or the owner is signing in from many new browsers.

## First check

Find who by IDs only.

1. The lines for the incident's `userId`: how many of each `reason`, and when they began.
2. The `request` lines with the same `requestId`s: the `route` (`/api/auth/*` for a code request,
   `/api/sign-up` for a sign-up's), the `status` and the `cfRay`. Look up a few Ray IDs in
   Cloudflare's own records for the console host to see the networks they came from; never copy an
   address or a query string.
3. Whether that account signed in meanwhile: the person-scope audit events for the `userId`
   (`session.created`, `browser.trusted`).
4. The empty series: whether the networks are few and the addresses many, which is probing for
   accounts rather than an attack on one.

## Containment

1. The owner's own new browsers (a new device, a cleared browser): nothing to undo. They can sign
   in with a passkey, or from a browser they have used before.
2. Someone else asking codes for the account: the owner's code was never cancelled, so nothing was
   taken. If the owner reports trouble signing in, tell them to use their passkey or a browser they
   have used before, through a channel you already know is theirs. Never tell anyone else what the
   lines say about the account.
3. If one network keeps it up at a volume that slows the console, raise it with the owner: a
   Cloudflare rule against that network is a reviewed change to the zone rules (`zone-apply.md`).
4. Close it when the contests stop; the incident recovers an hour after the count drops below the
   threshold.

## When to wake the owner

At once if the account signed in from a browser it did not know while the contests went on, or if
it holds an organisation's Super admin or Admin role and its owner cannot sign in. Contests that
signed nobody in can wait for working hours.
