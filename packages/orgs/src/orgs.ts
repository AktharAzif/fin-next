// What every organisation action shares, built once per process inside main() (never at module
// scope): the developer realm, this area's audit and email adapters, its limits, the credential
// registry and the invitation cookie's key.
import type { LineSink, Realm, UnitTx } from "@fin/identity";
import { createRecordOrgAudit, type RecordOrgAudit } from "./audit/record.ts";
import { CredentialRegistry } from "./credentials.ts";
import { createEnqueueOrgEmail, type EnqueueOrgEmail, type OrgEmail } from "./email.ts";
import type { DateClock } from "./ids.ts";
import { OrgLimits } from "./limits.ts";
import { InvitationCookie } from "./tokens.ts";

export interface Orgs {
  readonly realm: Realm;
  readonly clock: DateClock;
  readonly lines: LineSink;
  readonly audit: RecordOrgAudit;
  readonly email: EnqueueOrgEmail;
  readonly limits: OrgLimits;
  readonly credentials: CredentialRegistry;
  readonly invitationCookie: InvitationCookie;
}

export interface OrgsOptions {
  credentials?: CredentialRegistry;
  audit?: RecordOrgAudit;
  email?: EnqueueOrgEmail;
}

export function createOrgs(realm: Realm, options: OrgsOptions = {}): Orgs {
  if (realm.settings.realm !== "developer")
    throw new Error("organisations are the developer realm's");
  const clock = realm.runtime.clock;
  const lines = realm.runtime.lines;
  return {
    realm,
    clock,
    lines,
    audit: options.audit ?? createRecordOrgAudit({ clock, lines }),
    email: options.email ?? createEnqueueOrgEmail({ clock, lines }),
    limits: new OrgLimits(realm),
    credentials: options.credentials ?? new CredentialRegistry(),
    invitationCookie: new InvitationCookie(realm.settings.secrets),
  };
}

/**
 * Queues several notices in the action's transaction, each recipient once per template: the first
 * listed wins, so a person who is also one of the Super admins told gets the person's notice.
 */
export async function notifyEach(
  orgs: Orgs,
  tx: UnitTx,
  emails: readonly OrgEmail[],
): Promise<number> {
  const seen = new Set<string>();
  let sent = 0;
  for (const email of emails) {
    const key = `${email.template}\u0000${email.to.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await orgs.email(tx, email);
    sent += 1;
  }
  return sent;
}
