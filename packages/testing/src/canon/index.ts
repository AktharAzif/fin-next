// The canon: the fictional story every journey, screenshot and docs example is told in
// (ARCHITECTURE §11.4; spec 06 §10.2). Every address is on example.com, example.org or
// example.net; every person and company is invented. Keys, codes and secrets are never part of
// it: tests make those at run time.
//
// `seedCanon` walks the story in dependency order and hands each step to a `CanonWriter`, which
// each lane implements over its own API (sign-up and the sink's code, invitations, `pnpm fin
// staff bootstrap`, ...), so the canon is written the way a person would write it, with its audit
// events, rather than inserted behind the services' backs.
import { CANON_TIME } from "../clock.ts";
import { isFixtureAddress } from "../email/sink.ts";

export { CANON_TIME };

export type DashboardRoleKey = "super_admin" | "admin";
export type StaffRoleKey = "viewer" | "compliance" | "operator" | "admin";

export interface CanonPerson {
  readonly key: string;
  readonly name: string;
  readonly email: string;
}

export interface CanonCustomRole {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  /** Dashboard permission keys (spec 02 §8.2). */
  readonly permissions: readonly string[];
}

export interface CanonMembership {
  readonly person: string;
  /** A built-in role key or a custom role's key in the same organisation. */
  readonly role: string;
}

export interface CanonOrganisation {
  readonly key: string;
  readonly name: string;
  /** The person who signs up and creates it, its first Super admin. */
  readonly founder: string;
  readonly customRoles: readonly CanonCustomRole[];
  /** Everyone but the founder, invited in this order. */
  readonly members: readonly CanonMembership[];
}

export interface CanonStaffMember {
  readonly key: string;
  readonly name: string;
  readonly email: string;
  readonly role: StaffRoleKey;
}

export interface Canon {
  readonly time: string;
  readonly people: readonly CanonPerson[];
  readonly organisations: readonly CanonOrganisation[];
  readonly staff: readonly CanonStaffMember[];
}

const READ_ONLY = [
  "customers.read",
  "money.read",
  "webhooks.read",
  "apiKey.read",
  "member.read",
  "auditLog.read",
];

export const CANON: Canon = {
  time: CANON_TIME,
  people: [
    { key: "asha", name: "Asha Rao", email: "asha.rao@example.com" },
    { key: "ben", name: "Ben Okafor", email: "ben.okafor@example.com" },
    { key: "chen", name: "Chen Wei", email: "chen.wei@example.com" },
    { key: "dara", name: "Dara Kelly", email: "dara.kelly@example.org" },
    { key: "elif", name: "Elif Demir", email: "elif.demir@example.org" },
    { key: "femi", name: "Femi Adeyemi", email: "femi.adeyemi@example.net" },
    { key: "gita", name: "Gita Menon", email: "gita.menon@example.net" },
  ],
  organisations: [
    {
      key: "acme",
      name: "Acme Remit",
      founder: "asha",
      customRoles: [
        {
          key: "developer",
          name: "Developer",
          description: "Builds the integration in the Sandbox.",
          permissions: [
            "customers.read",
            "simulator.use",
            "webhooks.read",
            "webhooks.redeliver",
            "apiKey.read",
            "apiKey.sandbox",
          ],
        },
        {
          key: "compliance",
          name: "Compliance",
          description: "Follows customers and the Production request.",
          permissions: ["customers.read", "auditLog.read", "member.read", "golive.edit"],
        },
        {
          key: "billing",
          name: "Billing",
          description: "Watches money movement.",
          permissions: ["customers.read", "money.read"],
        },
        {
          key: "read_only",
          name: "Read only",
          description: "Sees everything it may and changes nothing.",
          permissions: READ_ONLY,
        },
      ],
      members: [
        { person: "ben", role: "admin" },
        { person: "chen", role: "developer" },
        { person: "dara", role: "compliance" },
        { person: "elif", role: "billing" },
        { person: "femi", role: "read_only" },
      ],
    },
    {
      key: "globex",
      name: "Globex Payouts",
      founder: "gita",
      customRoles: [
        {
          key: "read_only",
          name: "Viewers",
          description: "Read-only access for partners.",
          permissions: READ_ONLY,
        },
      ],
      // Ben is an Admin of Acme and a plain member here (spec 02 §6.2's two-organisation case).
      members: [{ person: "ben", role: "read_only" }],
    },
  ],
  staff: [
    { key: "grace", name: "Grace Hall", email: "grace.hall@example.com", role: "admin" },
    { key: "hiro", name: "Hiro Sato", email: "hiro.sato@example.com", role: "operator" },
    { key: "ines", name: "Ines Costa", email: "ines.costa@example.com", role: "compliance" },
    { key: "jonas", name: "Jonas Berg", email: "jonas.berg@example.com", role: "viewer" },
  ],
};

const BUILT_IN_DASHBOARD_ROLES = new Set<string>(["super_admin", "admin"]);

/** The problems in a canon (an empty list for a sound one). */
export function checkCanon(canon: Canon): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  const emails = new Set<string>();
  const addresses = [...canon.people, ...canon.staff];
  for (const entry of addresses) {
    if (keys.has(entry.key)) problems.push(`the key ${entry.key} is used twice`);
    keys.add(entry.key);
    const email = entry.email.toLowerCase();
    if (emails.has(email)) problems.push(`${entry.key}'s address is used twice`);
    emails.add(email);
    if (!isFixtureAddress(entry.email)) problems.push(`${entry.key}'s address is not a fixture`);
  }
  const people = new Set(canon.people.map((p) => p.key));
  for (const organisation of canon.organisations) {
    if (!people.has(organisation.founder)) {
      problems.push(`${organisation.key}'s founder is not a person`);
    }
    const roles = new Set([
      ...BUILT_IN_DASHBOARD_ROLES,
      ...organisation.customRoles.map((r) => r.key),
    ]);
    const seen = new Set([organisation.founder]);
    for (const member of organisation.members) {
      if (!people.has(member.person)) problems.push(`${organisation.key} lists an unknown person`);
      if (seen.has(member.person))
        problems.push(`${member.person} joins ${organisation.key} twice`);
      seen.add(member.person);
      if (!roles.has(member.role)) {
        problems.push(`${organisation.key} gives ${member.person} an unknown role`);
      }
      if (member.role === "super_admin") {
        problems.push(`${organisation.key}'s only Super admin is its founder`);
      }
    }
    for (const role of organisation.customRoles) {
      if (role.permissions.length === 0) problems.push(`${role.key} holds no permission`);
      if (BUILT_IN_DASHBOARD_ROLES.has(role.key)) problems.push(`${role.key} shadows a built-in`);
    }
  }
  return problems;
}

/** The steps a lane's writer performs, each naming what it needs from the earlier ones. */
export interface CanonWriter<Id = string> {
  /** Adds a staff member (the first Admin through `pnpm fin staff bootstrap`). */
  addStaffMember(member: CanonStaffMember): Promise<Id>;
  /** Signs a person up (with the sink's code) and creates their first organisation. */
  signUp(
    person: CanonPerson,
    organisation: CanonOrganisation,
  ): Promise<{ person: Id; organisation: Id }>;
  createCustomRole(organisation: Id, role: CanonCustomRole, actor: Id): Promise<Id>;
  /** Invites a person and has them accept, signing them up first if they have no account. */
  addMember(
    organisation: Id,
    person: CanonPerson,
    role: { readonly key: string; readonly id?: Id },
    actor: Id,
  ): Promise<{ person: Id; membership: Id }>;
}

export interface SeededCanon<Id = string> {
  readonly staff: ReadonlyMap<string, Id>;
  readonly people: ReadonlyMap<string, Id>;
  readonly organisations: ReadonlyMap<string, Id>;
  /** `<organisation>/<role>` to the custom role's ID. */
  readonly roles: ReadonlyMap<string, Id>;
}

export interface SeedOptions {
  /** Only these organisations (and their people). Default: all. */
  readonly organisations?: readonly string[];
  /** Seed the staff too (default true). */
  readonly staff?: boolean;
  /** Moves every address into a test's scope (an AddressBook's `scoped`). */
  readonly address?: (email: string) => string;
}

/** The canon with every address passed through `address`. */
export function scopeCanon(canon: Canon, address: (email: string) => string): Canon {
  return {
    ...canon,
    people: canon.people.map((p) => ({ ...p, email: address(p.email) })),
    staff: canon.staff.map((s) => ({ ...s, email: address(s.email) })),
  };
}

/** Writes the canon through `writer` in dependency order. Refuses an unsound canon. */
export async function seedCanon<Id>(
  writer: CanonWriter<Id>,
  options: SeedOptions = {},
  story: Canon = CANON,
): Promise<SeededCanon<Id>> {
  const canon = options.address === undefined ? story : scopeCanon(story, options.address);
  const problems = checkCanon(canon);
  if (problems.length > 0) throw new Error(`the canon is not sound:\n${problems.join("\n")}`);
  const staff = new Map<string, Id>();
  const people = new Map<string, Id>();
  const organisations = new Map<string, Id>();
  const roles = new Map<string, Id>();
  const person = (key: string) => canon.people.find((p) => p.key === key) as CanonPerson;

  if (options.staff ?? true) {
    const ordered = [...canon.staff].sort(
      (a, b) => Number(b.role === "admin") - Number(a.role === "admin"),
    );
    for (const member of ordered) staff.set(member.key, await writer.addStaffMember(member));
  }
  const wanted = options.organisations;
  for (const organisation of canon.organisations) {
    if (wanted !== undefined && !wanted.includes(organisation.key)) continue;
    const founder = person(organisation.founder);
    const made = await writer.signUp(founder, organisation);
    people.set(founder.key, made.person);
    organisations.set(organisation.key, made.organisation);
    for (const role of organisation.customRoles) {
      const id = await writer.createCustomRole(made.organisation, role, made.person);
      roles.set(`${organisation.key}/${role.key}`, id);
    }
    for (const member of organisation.members) {
      const custom = roles.get(`${organisation.key}/${member.role}`);
      const added = await writer.addMember(
        made.organisation,
        person(member.person),
        custom === undefined ? { key: member.role } : { key: member.role, id: custom },
        made.person,
      );
      if (!people.has(member.person)) people.set(member.person, added.person);
    }
  }
  return { staff, people, organisations, roles };
}

export { type AddressBook, createAddressBook, testScope } from "./addresses.ts";
export { type SeededRandom, seededRandom, seedFromEnv } from "./random.ts";
