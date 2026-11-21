// The reset link's check (the NewPassword board; spec 02 §5.7 with §5.2's link rules): the emailed
// link carries the address and the code in its fragment, and the page asks, before it shows the
// form, whether this browser asked for that address's reset. The answer is about this browser's own
// requests only (found by its `__Host-fin.code_browser` token), never another browser's, the
// address's account or whether one exists:
//   - `asking`: this browser holds the address's live reset request;
//   - `spent`: this browser asked, but that request has expired, was used or was replaced;
//   - `elsewhere`: this browser holds no reset request for the address.
import type { KeyedHasher } from "../crypto/keyed.ts";
import type { Clock } from "../ports/clock.ts";
import type { Queryable } from "../ports/db.ts";

export type ResetLinkState = "asking" | "spent" | "elsewhere";

export async function resetCodeLink(
  db: Queryable,
  deps: { clock: Clock; hasher: KeyedHasher },
  email: string,
  browserToken: string | null,
): Promise<ResetLinkState> {
  if (browserToken === null) return "elsewhere";
  const result = await db.query<{ live: boolean }>(
    `SELECT (superseded_at IS NULL AND used_at IS NULL AND expires_at > $3) AS live
       FROM identity.email_code_request
      WHERE email_hash = ANY($1) AND purpose = 'password_reset' AND browser_hash = ANY($2)
        AND NOT codeless
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [
      deps.hasher.hashes("email", email.trim().toLowerCase()),
      deps.hasher.hashes("browser", browserToken),
      deps.clock.now(),
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return "elsewhere";
  return row.live ? "asking" : "spent";
}
