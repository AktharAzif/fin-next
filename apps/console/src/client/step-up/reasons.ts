// The StepUp dialog's line, "Use your second factor to {reason}." (spec 02 §15.5). The reason comes
// from the answer's `reason_key`; the values in braces come from the page's own state, never from
// the server's answer: a page names them with `withReasonValues` around the call that may ask,
// together with the reason key that call's step-up carries.
//
// The values belong to their call. Each call in flight is one entry, removed when that call settles
// (and only that entry), and the dialog takes the values of the one call in flight that can ask for
// the reason it shows. When no call, or more than one, could have asked for it, the line names
// nothing ("Use your second factor to continue."): it never names the target of another action.

const REASONS = {
  "account.name": "change your name",
  "account.passkey_add": "add a passkey",
  "account.passkey_remove": "remove the passkey “{name}”",
  "account.totp_enable": "set up an authenticator app",
  "account.totp_disable": "turn off your authenticator app",
  "account.backup_codes": "replace your backup codes",
  "account.session_revoke": "sign out {device}",
  "account.sessions_revoke_others": "sign out your other devices",
  "account.trusted_browser_revoke": "stop trusting {browser}",
  "invitation.accept": "accept this invitation",
  "org.create": "create an organisation",
  "org.rename": "rename {organisation}",
  "org.delete": "delete {organisation}",
  "member.invite": "invite {email}",
  "invitation.change": "change the invitation for {email}",
  "invitation.resend": "send the invitation to {email} again",
  "invitation.cancel": "delete the invitation for {email}",
  "member.role": "change {name}’s role to {role}",
  "member.remove": "remove {name}",
  "role.create": "create the role {role}",
  "role.update": "save the role {role}",
  "role.delete": "delete the role {role}",
} as const satisfies Readonly<Record<string, string>>;

/** A reason key of spec 02 §15.5 that the console's own actions ask with. */
export type ReasonKey = keyof typeof REASONS;

export type ReasonValues = Readonly<Record<string, string>>;

/** One call in flight: the reason its step-up carries, and the page's values for it. */
interface InFlight {
  readonly reasonKey: ReasonKey;
  readonly values: ReasonValues;
}

const inFlight = new Set<InFlight>();

/**
 * Runs `fn`, a call whose step-up carries `reasonKey`, with the page's values for the reason line.
 * The values are this call's alone, and are dropped when it settles.
 */
export async function withReasonValues<T>(
  reasonKey: ReasonKey,
  values: ReasonValues,
  fn: () => Promise<T>,
): Promise<T> {
  const entry: InFlight = { reasonKey, values };
  inFlight.add(entry);
  try {
    return await fn();
  } finally {
    inFlight.delete(entry);
  }
}

/**
 * The page's values for a step-up that carries `reasonKey`: those of the one call in flight that
 * asks with it, or none when no call or more than one could have asked.
 */
export function valuesFor(reasonKey: string): ReasonValues {
  let found: ReasonValues | null = null;
  for (const entry of inFlight) {
    if (entry.reasonKey !== reasonKey) continue;
    if (found !== null) return {};
    found = entry.values;
  }
  return found ?? {};
}

/** The dialog's description for a reason key, with the page's values for it. */
export function reasonLine(reasonKey: string, values: ReasonValues = valuesFor(reasonKey)): string {
  if (!Object.hasOwn(REASONS, reasonKey)) return "Use your second factor to continue.";
  const template = REASONS[reasonKey as ReasonKey];
  let missing = false;
  const reason = template.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value.trim() === "") {
      missing = true;
      return "";
    }
    return value;
  });
  return missing ? "Use your second factor to continue." : `Use your second factor to ${reason}.`;
}
