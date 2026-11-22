// The audit log's sentences (spec 02 §14.5, §16.2, §16.3): drawn here from the row's event, its
// actor and its objects resolved to current labels, never from typed text the row could carry (it
// carries none, [AU-01]). "Maya Rivera changed the role of Priya Shah to Compliance." An event this
// file does not know reads as its name, so a newer server never breaks the page.
import { builtInRole, dashboardCatalogue } from "@fin/access";
import type { AuditRow } from "../api/contracts/audit.ts";

export interface Sentence {
  /** Who acted: a name, "You", or Fin for the system. */
  actor: string;
  verb: string;
  /** The object, by its current label (or its ID when it no longer exists). */
  object: string | null;
  /** The object is an ID, drawn in mono. */
  mono: boolean;
  tail: string;
}

const VERIFIED: Readonly<Record<string, string>> = {
  passkey: "Passkey",
  totp: "Authenticator",
  backup_code: "Backup code",
  session: "Session",
  email_otp: "Email code",
  password: "Password",
  google: "Google",
};

/** The "Verified by" chip's label, or null when the row has none. */
export function verifiedLabel(verification: string | null | undefined): string | null {
  if (verification === null || verification === undefined || verification === "") return null;
  return VERIFIED[verification] ?? null;
}

const CATEGORIES: Readonly<Record<string, string>> = {
  sign_in: "Sign-ins",
  security: "Security",
  team: "Team",
  api_keys: "API keys",
  organisation: "Organisation",
};

/** A type pill's label. */
export function categoryLabel(category: string | undefined): string {
  if (category === undefined) return "";
  return CATEGORIES[category] ?? category;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** A role key's label: a built-in's own, else null (a custom role's name comes from the refs). */
export function builtInLabel(roleKey: unknown): string | null {
  const key = text(roleKey);
  if (key === null) return null;
  return builtInRole(dashboardCatalogue, key)?.label ?? null;
}

/** Who acted, as the log names them. */
export function actorName(row: AuditRow, you: string | null = null): string {
  if (you !== null && row.actor.id === you) return "You";
  const name = text(row.actor.name) ?? text(row.actor.email);
  if (name !== null) return name;
  switch (row.actor.kind) {
    case "system":
    case "job":
      return "Fin";
    case "operator":
    case "staff":
      return "Fin support";
    case "api_key":
      return "An API key";
    default:
      return "Someone";
  }
}

function roleLabelOf(row: AuditRow, field: string): string | null {
  const key = row.metadata?.[field];
  const builtIn = builtInLabel(key);
  if (builtIn !== null) return builtIn;
  const id = text(key);
  if (id === null) return null;
  return text(row.refs?.find((ref) => ref.id === id)?.label) ?? null;
}

/** The sentence for one row. `you` is the viewer's user ID, so their own rows read "You". */
export function describe(row: AuditRow, you: string | null = null): Sentence {
  const actor = actorName(row, you);
  const label = text(row.target?.label);
  const objectOr = (fallbackId: boolean) =>
    label !== null
      ? { object: label, mono: false }
      : fallbackId && row.target !== null && row.target !== undefined
        ? { object: row.target.id, mono: true }
        : { object: null, mono: false };
  const s = (verb: string, tail = "", withObject = true): Sentence => ({
    actor,
    verb,
    ...(withObject ? objectOr(true) : { object: null, mono: false }),
    tail,
  });
  const m = row.metadata ?? {};
  const to = roleLabelOf(row, "toRole");
  const asRole = roleLabelOf(row, "roleKey");

  switch (row.event) {
    case "user.created":
      return s("created the account", "", false);
    case "user.name_changed":
    case "member.name_changed":
      return s("changed their name", "", false);
    case "session.created":
    case "member.signed_in":
      return s("signed in", "", false);
    case "session.ended":
      return s("signed out", "", false);
    case "session.revoked":
      return s("signed out a device", "", false);
    case "session.revoked_others":
      return s("signed out everywhere else", "", false);
    case "sign_in.second_factor_required":
      return s("was asked for a second factor", "", false);
    case "sign_in.failed":
      return s(
        m.reason === "passkey_failed"
          ? "used a passkey that didn’t work"
          : "entered a wrong or expired code",
        "",
        false,
      );
    case "sign_in.second_factor_failed":
      return s("entered a wrong code at the second factor", "", false);
    case "sign_in.locked":
      return s("was paused after too many wrong codes", "", false);
    case "two_factor.setup_started":
      return s("started setting up the authenticator app", "", false);
    case "two_factor.enabled":
      return s("turned on the authenticator app", "", false);
    case "two_factor.disabled":
      return s("turned off the authenticator app", "", false);
    case "backup_codes.regenerated":
      return s("made new backup codes", "", false);
    case "backup_code.used": {
      const left = typeof m.remaining === "number" ? `, ${m.remaining} left` : "";
      return s("used a backup code", left, false);
    }
    case "passkey.added":
      return s("added the passkey");
    case "passkey.removed":
      return s("removed the passkey");
    case "step_up.passed":
      return s("confirmed it was them", "", false);
    case "step_up.failed":
      return s("couldn’t confirm it was them", "", false);
    case "step_up.locked":
      return s("was signed out after too many wrong tries", "", false);
    case "browser.trusted":
      return s("trusted the browser");
    case "browser.trust_revoked":
      return s("stopped trusting the browser");
    case "organization.created":
      return s("created the organisation");
    case "organization.updated":
      return s("renamed the organisation");
    case "organization.deleted":
      return s("deleted the organisation");
    case "member.invited":
      return s("invited", asRole === null ? "" : ` as ${asRole}`);
    case "member.invitation_changed":
      return s("changed the invitation for", to === null ? "" : ` to ${to}`);
    case "member.invitation_resent":
      return s("sent the invitation again to");
    case "member.invitation_cancelled":
      return s("deleted the invitation for");
    case "member.invitation_declined":
      return s("declined the invitation", "", false);
    case "member.joined":
      return s("joined the team", asRole === null ? "" : ` as ${asRole}`, false);
    case "member.role_changed":
      return s("changed the role of", to === null ? "" : ` to ${to}`);
    case "member.removed":
      return s("removed");
    case "member.second_factor_added":
      return s("added a second factor", "", false);
    case "member.second_factor_removed":
      return s("removed their last second factor", "", false);
    case "role.created":
      return s("created the role");
    case "role.updated":
      return s("changed the role");
    case "role.deleted":
      return s("deleted the role");
    case "api_key.created":
      return s("created the key");
    case "api_key.updated":
      return s("changed the key");
    case "api_key.rolled":
      return s("rolled the key");
    case "api_key.revoked":
      return s("revoked the key");
    case "api_key.exposed":
      return s("was told the key was exposed", "", true);
    default:
      return s(row.event.replace(/[._]/g, " "));
  }
}

/** The whole sentence as text: a row's accessible name and the search's subject. */
export function sentenceText(sentence: Sentence): string {
  return `${sentence.actor} ${sentence.verb}${sentence.object === null ? "" : ` ${sentence.object}`}${sentence.tail}`;
}
