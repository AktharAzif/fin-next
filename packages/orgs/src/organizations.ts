// Organisations (spec 02 §9.1, §5.9; [SA-10], [BC-06], S2-08, S2-19): the first organisation, create,
// switch, rename and delete. Every change runs in the request's unit of work with its audit event
// and its notices; create, rename and delete take an intent, checked after every other rule.
import { isBuiltInKey } from "@fin/access";
import { checkName, type UnitTx } from "@fin/identity";
import { orgNameForEmail } from "./email.ts";
import { invalid, notFound, OrgRefusal } from "./errors.ts";
import type { Guarded, OrgActor } from "./guard.ts";
import { newId } from "./ids.ts";
import { SUPER_ADMIN_ORGANISATIONS } from "./limits.ts";
import { notifyEach, type Orgs } from "./orgs.ts";
import {
  CATALOGUE,
  customRolesOfMany,
  labelOf,
  lookupRole,
  membershipsOfPerson,
  membersOf,
  type OrganizationRow,
  TOP_ROLE,
} from "./store.ts";

/** Mail domains whose name says nothing about the person's organisation (§5.9). */
const PERSONAL_DOMAINS = new Set([
  "gmail",
  "googlemail",
  "outlook",
  "hotmail",
  "live",
  "msn",
  "yahoo",
  "ymail",
  "icloud",
  "me",
  "mac",
  "aol",
  "proton",
  "protonmail",
  "pm",
  "gmx",
  "mail",
  "zoho",
  "yandex",
  "fastmail",
  "hey",
  "tutanota",
  "example",
]);

const FALLBACK_NAME = "My organisation";

function titleCase(word: string): string {
  return word.length === 0 ? word : `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
}

/** Host labels that name a mail server, not an organisation (`mail.acme.com`). */
const MAIL_HOSTS = new Set(["mail", "email", "m", "mx", "smtp", "webmail", "post"]);

/**
 * The first organisation's name (§5.9): built from the work address's domain ("Acme Payments" for
 * an address at acme-payments.example.net), else from the first name ("Ada's organisation"), passed through the
 * organisation-name rule; "My organisation" when nothing usable can be built. The domain's most
 * specific label that is not a mail host and not its top-level label names the organisation.
 */
export function firstOrganizationName(person: { email: string; name: string }): string {
  const domain = person.email.slice(person.email.lastIndexOf("@") + 1).toLowerCase();
  const labels = domain.split(".").filter((l) => l !== "");
  const base = labels.slice(0, -1).find((label) => !MAIL_HOSTS.has(label));
  if (base !== undefined && !PERSONAL_DOMAINS.has(base)) {
    const name = base
      .split(/[-_]+/)
      .filter((w) => w !== "")
      .map(titleCase)
      .join(" ");
    const checked = checkName("organisationName", name);
    if (checked.ok && checked.value !== "") return checked.value;
  }
  const first = person.name.trim().split(/\s+/)[0] ?? "";
  if (first !== "") {
    const checked = checkName("organisationName", `${first}'s organisation`);
    if (checked.ok && checked.value !== "") return checked.value;
  }
  return FALLBACK_NAME;
}

/** A typed organisation name, or `400 invalid` naming the field and the rule's reason. */
export function organisationName(input: string, path = "name"): string {
  const checked = checkName("organisationName", input);
  if (!checked.ok || checked.value === "") {
    throw invalid([{ path, code: checked.ok ? "empty" : checked.reason }]);
  }
  return checked.value;
}

async function superAdminOrganisations(tx: UnitTx, userId: string): Promise<number> {
  const result = await tx.query<{ n: number }>(
    `SELECT count(*)::integer AS n FROM identity.member m
       JOIN identity.organization o ON o.id = m.organization_id AND o.deleted_at IS NULL
      WHERE m.user_id = $1 AND m.role_key = $2`,
    [userId, TOP_ROLE],
  );
  return Number(result.rows[0]?.n ?? Number.NaN);
}

async function insertOrganization(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  name: string,
  first: boolean,
): Promise<{ orgId: string; memberId: string }> {
  const now = orgs.clock.now();
  const orgId = newId("org", orgs.clock);
  const memberId = newId("mem", orgs.clock);
  await tx.query(
    `INSERT INTO identity.organization (id, name, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4)`,
    [orgId, name, who.person.id, now],
  );
  await tx.query(
    `INSERT INTO identity.member (id, organization_id, user_id, role_key, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5)`,
    [memberId, orgId, who.person.id, TOP_ROLE, now],
  );
  // The new organisation is the one the SPA opens next (navigation only).
  await tx.query(
    "UPDATE identity.session SET current_organization_id = $1, updated_at = $3 WHERE id = $2",
    [orgId, who.person.sessionId, now],
  );
  await orgs.audit(tx, {
    event: "organization.created",
    actor: who.actor,
    target: orgId,
    refs: [memberId, who.person.id],
    organizationId: orgId,
    metadata: { first },
    context: who.context,
  });
  return { orgId, memberId };
}

async function checkOrganisationAllowance(tx: UnitTx, who: Guarded): Promise<void> {
  const held = await superAdminOrganisations(tx, who.person.id);
  if (!(Number.isSafeInteger(held) && held < SUPER_ADMIN_ORGANISATIONS)) {
    throw new OrgRefusal("limit_reached", "limits.super_admin_organisations", {
      limit: SUPER_ADMIN_ORGANISATIONS,
    });
  }
}

/**
 * `POST /api/orgs/first` (§5.9, S2-08): a person with no membership gets an organisation as its
 * Super admin, with no step-up (the person has no factor yet and nothing to protect).
 */
export async function createFirstOrganization(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
): Promise<{ orgId: string; name: string }> {
  // Serialised per person, so two first-organisation requests cannot both pass.
  await tx.query('SELECT 1 FROM identity."user" WHERE id = $1 FOR UPDATE', [who.person.id]);
  if ((await membershipsOfPerson(tx, who.person.id)).length > 0) {
    throw new OrgRefusal("already_member", "org.has_membership");
  }
  await checkOrganisationAllowance(tx, who);
  const name = firstOrganizationName(who.person);
  await orgs.limits.count(tx, "org_change", who.person.id);
  const { orgId } = await insertOrganization(orgs, tx, who, name, true);
  return { orgId, name };
}

/** `POST /api/orgs` (§9.1): a person with a factor and an intent; at most 10 as Super admin. */
export async function createOrganization(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  body: { name: string },
): Promise<{ orgId: string; name: string }> {
  const name = organisationName(body.name);
  await tx.query('SELECT 1 FROM identity."user" WHERE id = $1 FOR UPDATE', [who.person.id]);
  await checkOrganisationAllowance(tx, who);
  await who.confirm({ body: { name }, target: null, organizationId: null });
  await orgs.limits.count(tx, "org_change", who.person.id);
  const { orgId } = await insertOrganization(orgs, tx, who, name, false);
  return { orgId, name };
}

/** `PUT /api/viewer/organization` (§9.1): navigation only, a log line and no audit row. */
export async function switchOrganization(
  orgs: Orgs,
  tx: UnitTx,
  who: Guarded,
  orgId: string,
): Promise<void> {
  const memberships = await membershipsOfPerson(tx, who.person.id);
  if (!memberships.some((m) => m.orgId === orgId)) throw notFound("org.not_member");
  await tx.query(
    "UPDATE identity.session SET current_organization_id = $1, updated_at = $3 WHERE id = $2",
    [orgId, who.person.sessionId, orgs.clock.now()],
  );
  orgs.lines.write("org.switched", "info", { orgId, userId: who.person.id });
}

export interface OrganizationSummary {
  orgId: string;
  name: string;
  liveStatus: string;
  roleKey: string;
  roleLabel: string;
  roleKnown: boolean;
}

/** `GET /api/orgs` (§14.2): the person's organisations with their role labels, paged. */
export async function listOrganizations(
  tx: UnitTx,
  who: Guarded,
  page: { page: number; size: number },
): Promise<{ items: OrganizationSummary[]; total: number; totalCapped: boolean }> {
  const memberships = await membershipsOfPerson(tx, who.person.id);
  const roles = await customRolesOfMany(
    tx,
    memberships.map((m) => m.orgId),
  );
  const all = memberships.map((m) => {
    const role = lookupRole(roles.get(m.orgId) ?? new Map(), m.roleKey);
    return {
      orgId: m.orgId,
      name: m.orgName,
      liveStatus: m.liveStatus,
      roleKey: m.roleKey,
      roleLabel: labelOf(role),
      roleKnown: typeof role !== "string",
    };
  });
  const start = (page.page - 1) * page.size;
  return {
    items: all.slice(start, start + page.size),
    total: Math.min(all.length, 10_000),
    totalCapped: all.length > 10_000,
  };
}

/** `GET /api/org` (§14.2): the profile, its live status and the viewer's role. */
export function organizationProfile(actor: OrgActor): {
  orgId: string;
  name: string;
  liveStatus: string;
  createdAt: string;
  role: { key: string; label: string; known: boolean; builtIn: boolean };
} {
  return {
    orgId: actor.organization.id,
    name: actor.organization.name,
    liveStatus: actor.organization.liveStatus,
    createdAt: actor.organization.createdAt.toISOString(),
    role: {
      key: actor.member.roleKey,
      label: labelOf(actor.role),
      known: typeof actor.role !== "string",
      builtIn: isBuiltInKey(CATALOGUE, actor.member.roleKey),
    },
  };
}

/** `PATCH /api/org` (§9.1): `organization.update` and an intent; the same name is `unchanged`. */
export async function renameOrganization(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  body: { name: string },
): Promise<{ orgId: string; name: string }> {
  const name = organisationName(body.name);
  const org = actor.organization;
  if (name === org.name) {
    throw new OrgRefusal("invalid", "org.unchanged", {
      problem: "unchanged",
      fields: [{ path: "name", code: "unchanged" }],
    });
  }
  await actor.confirm({ body: { name }, target: org.id, organizationId: org.id });
  await orgs.limits.count(tx, "org_rename", org.id);
  await tx.query("UPDATE identity.organization SET name = $2, updated_at = $3 WHERE id = $1", [
    org.id,
    name,
    orgs.clock.now(),
  ]);
  await orgs.audit(tx, {
    event: "organization.updated",
    actor: actor.actor,
    target: org.id,
    organizationId: org.id,
    metadata: { fields: ["name"] },
    context: actor.context,
  });
  return { orgId: org.id, name };
}

/**
 * `DELETE /api/org` (§9.1, S2-19): `organization.delete`, an intent, the typed name; refused while
 * the organisation has Production access. In one transaction: `deleted_at` set, every pending
 * invitation cancelled, every custom role and membership deleted, `organization.deleted` with its
 * revocation-journal entry, and `organization-deleted` to every member. API keys (stretch 1) are not
 * built, so none is revoked.
 */
export async function deleteOrganization(
  orgs: Orgs,
  tx: UnitTx,
  actor: OrgActor,
  body: { confirmName: string },
): Promise<{ orgId: string }> {
  const org: OrganizationRow = actor.organization;
  if (body.confirmName !== org.name) {
    throw invalid([{ path: "confirmName", code: "mismatch" }], "org.confirm_name");
  }
  if (org.liveStatus === "approved") {
    throw new OrgRefusal("approved_for_live", "org.approved_for_live");
  }
  await actor.confirm({
    body: { confirmName: body.confirmName },
    target: org.id,
    organizationId: org.id,
  });
  await orgs.limits.count(tx, "org_change", actor.person.id);
  const now = orgs.clock.now();
  const members = await membersOf(tx, org.id);
  const invitations = await tx.query<{ id: string }>(
    `UPDATE identity.invitation SET status = 'cancelled', cancel_reason = 'organisation_deleted',
            answered_at = $2
      WHERE organization_id = $1 AND status = 'pending' RETURNING id`,
    [org.id, now],
  );
  for (const row of invitations.rows) {
    await orgs.audit(tx, {
      event: "member.invitation_cancelled",
      actor: actor.actor,
      target: row.id,
      refs: [org.id],
      organizationId: org.id,
      metadata: { reason: "organisation_deleted" },
      context: actor.context,
    });
  }
  const roles = await tx.query<{ id: string }>(
    "DELETE FROM identity.role WHERE organization_id = $1 RETURNING id",
    [org.id],
  );
  await tx.query("DELETE FROM identity.member WHERE organization_id = $1", [org.id]);
  await tx.query(
    "UPDATE identity.organization SET deleted_at = $2, updated_at = $2 WHERE id = $1",
    [org.id, now],
  );
  await orgs.audit(tx, {
    event: "organization.deleted",
    actor: actor.actor,
    target: org.id,
    // The custom roles deleted with it (at most 30): their rows' guards accept this event.
    refs: roles.rows.map((r) => r.id),
    organizationId: org.id,
    metadata: {
      members: members.length,
      invitations: invitations.rows.length,
      keysRevoked: 0,
    },
    context: actor.context,
  });
  await notifyEach(
    orgs,
    tx,
    members.map((m) => ({
      template: "orgs/organization-deleted" as const,
      to: m.email,
      params: {
        orgId: org.id,
        orgName: orgNameForEmail(org.name),
        time: now.toISOString(),
      },
    })),
  );
  return { orgId: org.id };
}
