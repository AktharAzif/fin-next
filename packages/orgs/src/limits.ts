// The organisation area's limits (spec 02 §5.6, [DA-16], [BC-06]), counted in Postgres by the realm's
// limit store on `ops.rate_window` (fixed windows, one atomic statement each). An action is counted
// once it is going ahead, after its step-up has passed, so asking for a factor never spends an
// allowance; a refusal at that point rolls the whole unit back, the intent's consumption included,
// so the person may retry within the intent's life. The store fails closed (503,
// `limits.store_failed`). Subjects are IDs or keyed hashes, never an address in clear.
import { AuthRefusal, type Realm, type UnitTx } from "@fin/identity";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const ORG_LIMITS = {
  /** Organisations made or deleted: 10 per hour and 20 per day per person. */
  org_change: [
    { ms: HOUR, max: 10 },
    { ms: DAY, max: 20 },
  ],
  /** Renames: 5 per hour and 20 per day per organisation. */
  org_rename: [
    { ms: HOUR, max: 5 },
    { ms: DAY, max: 20 },
  ],
  /** Invitations sent (made, changed or resent): 30 per hour and 50 per day per organisation. */
  invite_org: [
    { ms: HOUR, max: 30 },
    { ms: DAY, max: 50 },
  ],
  /** 20 per day per inviter. */
  invite_inviter: [{ ms: DAY, max: 20 }],
  /** 3 per day per organisation and address. */
  invite_org_address: [{ ms: DAY, max: 3 }],
  /** 10 per day per address across organisations. */
  invite_address: [{ ms: DAY, max: 10 }],
  /** Giving more access (role changes upwards): 20 per hour and 40 per day per person. */
  role_raise: [
    { ms: HOUR, max: 20 },
    { ms: DAY, max: 40 },
  ],
  /** Custom role edits: 30 per hour and 100 per day per person ([SA-11], §8.4). */
  role_edit: [
    { ms: HOUR, max: 30 },
    { ms: DAY, max: 100 },
  ],
} as const;

export type OrgLimitBucket = keyof typeof ORG_LIMITS;

/** At most 10 organisations as Super admin per person ([BC-06]). */
export const SUPER_ADMIN_ORGANISATIONS = 10;
/** At most 25 pending invitations per organisation (§5.6). */
export const PENDING_INVITATIONS = 25;

export class OrgLimits {
  readonly #realm: Realm;
  constructor(realm: Realm) {
    this.#realm = realm;
  }

  /** An address's subject: a keyed hash, so a bucket never carries an address in clear. */
  addressSubject(email: string): string {
    return this.#realm.runtime.hasher.bucket("email", email.toLowerCase());
  }

  /** Counts one use in every window of `bucket`; refuses with 429 (rolling the unit back) past one. */
  async count(tx: UnitTx, bucket: OrgLimitBucket, subject: string): Promise<void> {
    const result = await this.#realm.runtime.limits.consumeWindows(
      tx,
      bucket,
      ORG_LIMITS[bucket],
      subject,
    );
    if (!result.allowed) {
      throw new AuthRefusal(
        "rate_limited",
        `limits.${bucket}`,
        { retry_after: result.retryAfter },
        { rollback: true },
      );
    }
  }
}
