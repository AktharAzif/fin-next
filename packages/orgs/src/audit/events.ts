// The organisation-scope audit events (spec 02 §16.3; spec 08 §3.4's `orgs.ts` fragment, the
// canonical names). They are written in defineEvents' shape (packages/audit, spec 08 §3.2): the
// console's adapter (record.ts) checks them before `audit.record()`, and the template database
// reads `eventTypeRows()`. packages/audit/src/events/orgs.ts is what `migrate` syncs to
// audit.event_type, and fragment.test.ts holds it equal to these.
//
// Metadata is flat and strict: IDs, role and permission keys, counts, enums and booleans. Never a
// name, an address, a token or typed text (spec 02 §16.1, ARCHITECTURE §8.2): a name shown on the
// audit log is resolved from the current row when it is read (§14.5).
import * as z from "zod";

export type AuditCategory = "organisation" | "team";
export type ActorKind = "user" | "system";
export type ActorVia = "console" | "job";
export type JournalKind = "member_removed" | "role_lowered" | "organisation_deleted";

export interface EventSpec<M extends z.ZodObject = z.ZodObject> {
  readonly category: AuditCategory;
  readonly scope: "organisation";
  readonly roles: readonly ["fin_console"];
  readonly actors: readonly ActorKind[];
  /** The target ID's prefix. */
  readonly target: "org" | "mem" | "inv" | "rol";
  readonly metadata: M;
  /** The revocation-journal entry written in the same transaction (spec 02 §16.6, [AU-04]). */
  readonly journal?: {
    readonly kind: JournalKind;
    readonly when?: (metadata: z.infer<M>) => boolean;
  };
}

const ROLE_KEY = /^([a-z][a-z_]{0,31}|rol_[0-9a-hjkmnp-tv-z]{26})$/;
const PERMISSION = /^[a-z][a-zA-Z]*\.[a-z][a-z_]*$/;
const roleKey = z.string().regex(ROLE_KEY);
const permissions = z.array(z.string().regex(PERMISSION)).max(64);
const count = z.int().min(0).max(1_000_000);
const empty = z.strictObject({});
const cancelReason = z.enum([
  "cancelled",
  "replaced",
  "inviter_removed",
  "inviter_demoted",
  "role_deleted",
  "organisation_deleted",
]);

function event<M extends z.ZodObject>(
  category: AuditCategory,
  target: EventSpec["target"],
  metadata: M,
  journal?: EventSpec<M>["journal"],
): EventSpec<M> {
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

const roleChanged = z.strictObject({
  fromRole: roleKey,
  toRole: roleKey,
  reason: z.enum(["changed", "role_deleted"]),
  // Whether the change took permissions away: such a change is a role lowered for the journal.
  lowered: z.boolean(),
});
const roleUpdated = z.strictObject({
  added: permissions,
  removed: permissions,
  holders: count,
  renamed: z.boolean(),
});

export const ORGS_EVENTS = {
  "organization.created": event("organisation", "org", z.strictObject({ first: z.boolean() })),
  "organization.updated": event(
    "organisation",
    "org",
    z.strictObject({
      fields: z
        .array(z.enum(["name"]))
        .min(1)
        .max(1),
    }),
  ),
  "organization.deleted": event(
    "organisation",
    "org",
    z.strictObject({ members: count, invitations: count, keysRevoked: count }),
    { kind: "organisation_deleted" },
  ),
  "member.invited": event("team", "inv", z.strictObject({ roleKey })),
  "member.invitation_changed": event(
    "team",
    "inv",
    z.strictObject({
      fromRole: roleKey,
      toRole: roleKey,
      reason: z.enum(["edited", "role_deleted"]),
    }),
  ),
  "member.invitation_resent": event("team", "inv", empty),
  "member.invitation_cancelled": event("team", "inv", z.strictObject({ reason: cancelReason })),
  "member.invitation_declined": event("team", "inv", empty),
  "member.joined": event("team", "mem", z.strictObject({ roleKey })),
  "member.role_changed": event("team", "mem", roleChanged, {
    kind: "role_lowered",
    when: (m: z.infer<typeof roleChanged>) => m.lowered,
  }),
  "member.removed": event(
    "team",
    "mem",
    z.strictObject({ credentialsListed: count, credentialsRolled: count }),
    { kind: "member_removed" },
  ),
  "member.signed_in": event(
    "team",
    "mem",
    z.strictObject({
      method: z.enum(["email_otp", "passkey", "totp", "backup_code", "password", "google"]),
    }),
  ),
  "member.second_factor_added": event("team", "mem", empty),
  "member.second_factor_removed": event("team", "mem", empty),
  "member.name_changed": event("team", "mem", empty),
  "role.created": event("team", "rol", z.strictObject({ permissions })),
  "role.updated": event("team", "rol", roleUpdated, {
    kind: "role_lowered",
    when: (m: z.infer<typeof roleUpdated>) => m.removed.length > 0,
  }),
  "role.deleted": event(
    "team",
    "rol",
    z.strictObject({
      movedTo: roleKey.nullable(),
      membersMoved: count,
      invitationsMoved: count,
    }),
  ),
} as const;

export type OrgsEventName = keyof typeof ORGS_EVENTS;
export type OrgsEventMetadata<E extends OrgsEventName> = z.input<
  (typeof ORGS_EVENTS)[E]["metadata"]
>;

/**
 * The events the identity realm's hooks write in the session's or the factor's own transaction
 * (one per membership, §16.3, S2-36). They are declared here, in the area's fragment, and recorded
 * by packages/identity's after-hook; until that lane writes them, nothing in this package does.
 */
export const REALM_WRITTEN_EVENTS: readonly OrgsEventName[] = [
  "member.signed_in",
  "member.second_factor_added",
  "member.second_factor_removed",
];

export interface EventTypeRow {
  name: OrgsEventName;
  area: "orgs";
  category: AuditCategory;
  scope: "organisation";
  roles: readonly string[];
  journalKind: JournalKind | null;
}

/** The registry rows `audit.event_type` needs for these events (spec 08 §3.2's audit-sync). */
export function eventTypeRows(): EventTypeRow[] {
  return (Object.entries(ORGS_EVENTS) as [OrgsEventName, EventSpec][]).map(([name, spec]) => ({
    name,
    area: "orgs",
    category: spec.category,
    scope: spec.scope,
    roles: spec.roles,
    journalKind: spec.journal?.kind ?? null,
  }));
}
