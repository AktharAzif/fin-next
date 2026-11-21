// "Use your second factor to {reason}." (spec 02 §15.5). The reason is picked by the answer's
// `reason_key`; the values in braces come from the page's own state (the subject the screen set
// before it called), never from the server's answer. A key Fin Admin does not know, or one whose
// values the page did not give, says "continue", so nothing the server sends is ever shown.
import { createStore, type Store } from "@fin/frame";

export type StepUpSubject = Readonly<Record<string, string>>;

type Reason = (subject: StepUpSubject) => string | null;

const need =
  (template: string, ...keys: string[]): Reason =>
  (subject) => {
    let text = template;
    for (const key of keys) {
      const value = subject[key];
      if (value === undefined || value === "") return null;
      text = text.replace(`{${key}}`, value);
    }
    return text;
  };

/** Spec 02 §15.5's staff keys, and the staff realm's own reason keys for factors and sessions. */
const REASONS: Readonly<Record<string, Reason>> = {
  "staff.add": need("add {email} to staff", "email"),
  "staff.role": need("change {email}’s role to {role}", "email", "role"),
  "staff.remove": need("remove {email} from staff", "email"),
  "staff.reset_factors": need("reset {email}’s second factors", "email"),
  "staff.enrolment_code": need("make a new enrolment code for {email}", "email"),
  // §15.5's `staffRole.*`, keyed as the intent table writes them (`staff_role.*`).
  "staff_role.create": need("create the staff role {role}", "role"),
  "staff_role.update": need("save the staff role {role}", "role"),
  "staff_role.delete": need("delete the staff role {role}", "role"),
  "account.passkey_add": () => "add a passkey",
  "account.passkey_remove": need("remove the passkey “{name}”", "name"),
  "account.totp_enable": () => "set up an authenticator app",
  "account.totp_disable": () => "turn off your authenticator app",
  "account.session_revoke": need("sign out {device}", "device"),
  "account.sessions_revoke_others": () => "sign out your other devices",
  "staff.session_revoke": need("sign out {device}", "device"),
  "staff.sessions_revoke_others": () => "sign out your other devices",
  // The staff realm's keys for its own endpoints (L-SAT-02's step-up catalogue).
  add_factor: (subject) =>
    subject.factor === "authenticator"
      ? "set up an authenticator app"
      : subject.factor === "passkey"
        ? "add a passkey"
        : null,
  remove_factor: (subject) =>
    subject.factor === "authenticator"
      ? "turn off your authenticator app"
      : need("remove the passkey “{name}”", "name")(subject),
  sign_out_session: need("sign out {device}", "device"),
  sign_out_everywhere: () => "sign out your other devices",
};

/** The dialog's line for a reason key and the page's subject. */
export function reasonSentence(reasonKey: string, subject: StepUpSubject): string {
  const reason = Object.hasOwn(REASONS, reasonKey) ? REASONS[reasonKey]?.(subject) : null;
  return `Use your second factor to ${reason ?? "continue"}.`;
}

/**
 * What the page is doing, for the dialog's line: set by the screen just before the call that may
 * ask for a step-up, cleared when it settles. The dialog sits at the root, outside the page.
 */
const subjectStore: Store<StepUpSubject> = createStore<StepUpSubject>({});

export function stepUpSubject(): Store<StepUpSubject> {
  return subjectStore;
}

/** Runs `action` with `subject` as the dialog's subject, and clears it afterwards. */
export async function withStepUpSubject<T>(
  subject: StepUpSubject,
  action: () => Promise<T>,
): Promise<T> {
  subjectStore.set(subject);
  try {
    return await action();
  } finally {
    if (subjectStore.get() === subject) subjectStore.set({});
  }
}
