// The organisation area's events (spec 08 §3.4's `orgs.ts`, L-SAT-03; spec 02 §16.3): organisations,
// members, invitations and custom roles, recorded by `fin_console`. @fin/orgs records them itself
// (its ORGS_EVENTS, in this shape); this fragment is what the registry sync writes to
// audit.event_type, so `migrate --migrate` registers them. The orgs fragment test holds the two
// equal, field by field. Metadata is IDs, role and permission keys, counts, enums and booleans.
import { z } from "zod";
import { type AuditCategory, defineEvents, type EventSpec } from "../define.ts";

const roleKey = z.string().regex(/^([a-z][a-z_]{0,31}|rol_[0-9a-hjkmnp-tv-z]{26})$/);
const permissions = z.array(z.string().regex(/^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/)).max(64);
const count = z.int().min(0).max(1_000_000);
const empty = z.object({}).strict();
const cancelReason = z.enum([
  "cancelled",
  "replaced",
  "inviter_removed",
  "inviter_demoted",
  "role_deleted",
  "organisation_deleted",
]);
const roleChanged = z
  .object({
    fromRole: roleKey,
    toRole: roleKey,
    reason: z.enum(["changed", "role_deleted"]),
    // Whether the change took permissions away: such a change is a role lowered for the journal.
    lowered: z.boolean(),
  })
  .strict();
const roleUpdated = z
  .object({ added: permissions, removed: permissions, holders: count, renamed: z.boolean() })
  .strict();

function event(
  category: AuditCategory,
  target: "org" | "mem" | "inv" | "rol",
  metadata: z.ZodObject,
  journal?: EventSpec["journal"],
): EventSpec {
  return {
    category,
    scope: "organisation",
    roles: ["fin_console"],
    actors: ["user", "system"],
    target,
    metadata,
    ...(journal === undefined ? {} : { journal }),
  };
}

export const events = defineEvents("orgs", {
  "organization.created": event("organisation", "org", z.object({ first: z.boolean() }).strict()),
  "organization.updated": event(
    "organisation",
    "org",
    z
      .object({
        fields: z
          .array(z.enum(["name"]))
          .min(1)
          .max(1),
      })
      .strict(),
  ),
  "organization.deleted": event(
    "organisation",
    "org",
    z.object({ members: count, invitations: count, keysRevoked: count }).strict(),
    { kind: "organisation_deleted" },
  ),
  "member.invited": event("team", "inv", z.object({ roleKey }).strict()),
  "member.invitation_changed": event(
    "team",
    "inv",
    z
      .object({
        fromRole: roleKey,
        toRole: roleKey,
        reason: z.enum(["edited", "role_deleted"]),
      })
      .strict(),
  ),
  "member.invitation_resent": event("team", "inv", empty),
  "member.invitation_cancelled": event("team", "inv", z.object({ reason: cancelReason }).strict()),
  "member.invitation_declined": event("team", "inv", empty),
  "member.joined": event("team", "mem", z.object({ roleKey }).strict()),
  "member.role_changed": event("team", "mem", roleChanged, {
    kind: "role_lowered",
    when: (m) => m.lowered === true,
  }),
  "member.removed": event(
    "team",
    "mem",
    z.object({ credentialsListed: count, credentialsRolled: count }).strict(),
    { kind: "member_removed" },
  ),
  "member.signed_in": event(
    "team",
    "mem",
    z
      .object({
        method: z.enum(["email_otp", "passkey", "totp", "backup_code", "password", "google"]),
      })
      .strict(),
  ),
  "member.second_factor_added": event("team", "mem", empty),
  "member.second_factor_removed": event("team", "mem", empty),
  "member.name_changed": event("team", "mem", empty),
  "role.created": event("team", "rol", z.object({ permissions }).strict()),
  "role.updated": event("team", "rol", roleUpdated, {
    kind: "role_lowered",
    when: (m) => Array.isArray(m.removed) && m.removed.length > 0,
  }),
  "role.deleted": event(
    "team",
    "rol",
    z
      .object({
        movedTo: roleKey.nullable(),
        membersMoved: count,
        invitationsMoved: count,
      })
      .strict(),
  ),
});
