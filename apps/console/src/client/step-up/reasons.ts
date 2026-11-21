// The StepUp dialog's line, "Use your second factor to {reason}." (spec 02 §15.5). The reason comes
// from the answer's `reason_key`; the values in braces come from the page's own state, never from
// the server's answer: a page names them with `withReasonValues` around the call that may ask.

const REASONS: Readonly<Record<string, string>> = {
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
};

export type ReasonValues = Readonly<Record<string, string>>;

let current: ReasonValues = {};

/** Runs `fn` with the page's values for the reason line; cleared when it settles. */
export async function withReasonValues<T>(values: ReasonValues, fn: () => Promise<T>): Promise<T> {
  const before = current;
  current = values;
  try {
    return await fn();
  } finally {
    current = before;
  }
}

/** The dialog's description for a reason key, with the page's values. */
export function reasonLine(reasonKey: string, values: ReasonValues = current): string {
  const template = REASONS[reasonKey];
  if (template === undefined) return "Use your second factor to continue.";
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
