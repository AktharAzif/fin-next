// Custom staff roles in the admin API stand-in (test target only; spec 02 §10.7, §8.4, §14.3), so
// AdminRoles and AdminRoleEditor journeys run against the built app before the real admin API test
// server serves them. It keeps the contract @fin/staff answers (apps/admin's staff-roles.db.test.ts
// pins it) and decides with the same permission engine the server runs: `validateRole` (without
// the identity package's full name rules, which the server adds), `editingProblem` and
// `deletionProblem`, the version, the 30-role limit, the holders a deletion or a save adding a
// permission names (exactly the role's holders now, or `409 conflict`), and an intent bound to
// each change through the stand-in's own step-up. Every change appends its audit event to the
// stand-in's trail.
import {
  CUSTOM_ROLE_LIMIT,
  customRoleLimitReached,
  deletionProblem,
  editingProblem,
  normaliseRoleText,
  permissionDiff,
  permissionsOf,
  type RoleLookup,
  type RoleProblem,
  resolveRole,
  type StaffPermission,
  type StaffRoleKey,
  sortPermissions,
  staffCatalogue,
  summary,
  validateRole,
} from "@fin/access";

/** A role as the stand-in's staff routes read it. */
export interface StandInRole {
  readonly key: string;
  readonly label: string;
  readonly summary: string;
  readonly permissions: readonly string[];
}

interface CustomRole {
  readonly id: string;
  name: string;
  description: string;
  permissions: StaffPermission[];
  version: number;
}

/** The answer shape of the stand-in (its own `Answer`), built by the host's helpers. */
export interface RoleAnswer {
  readonly status: number;
  readonly body?: unknown;
  readonly problem?: boolean;
}

/** What a staff roles request may use of the stand-in: its member, step-up and trail. */
export interface RolesHost {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly actor: { readonly id: string; readonly roleKey: string };
  /** `403 forbidden` unless the actor's role holds the permission. */
  needs(permission: string): RoleAnswer | null;
  /** The intent check of the stand-in (§7): null once a proved, unspent intent is spent. */
  stepUp(action: string, reasonKey: string, params: Record<string, unknown>): RoleAnswer | null;
  record(event: string, target: string, metadata?: Record<string, unknown>): void;
  /** The pending and active members holding a role key now. */
  holders(roleKey: string): readonly { readonly id: string }[];
  /** Gives a member another role and ends their sessions (S2-20). */
  move(memberId: string, roleKey: string): void;
  /** The four prebuilt roles. */
  readonly prebuilt: readonly StandInRole[];
  problem(code: string, extensions?: Record<string, unknown>): RoleAnswer;
  ok(body: unknown, status?: number): RoleAnswer;
}

const ID = /^srl_[0-9a-hjkmnp-tv-z]{26}$/;
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function newRoleId(): string {
  let id = "srl_";
  for (const byte of crypto.getRandomValues(new Uint8Array(26))) id += ALPHABET[byte % 32];
  return id;
}

const FIELD: Readonly<Record<Exclude<RoleProblem, "beyond">, string>> = {
  name: "name",
  name_taken: "name",
  reads_as_built_in: "name",
  description: "description",
  empty: "permissions",
  restricted: "permissions",
  missing_need: "permissions",
};

export class StaffRolesStandIn {
  readonly roles = new Map<string, CustomRole>();

  reset(): void {
    this.roles.clear();
  }

  #lookup(key: string): RoleLookup<StaffRoleKey> {
    return resolveRole(staffCatalogue, key, (id) => {
      const role = this.roles.get(id);
      return role === undefined
        ? undefined
        : {
            id: role.id,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
          };
    });
  }

  /** A custom role as the stand-in's other routes read roles, or undefined. */
  role(key: string): StandInRole | undefined {
    const lookup = this.#lookup(key);
    if (typeof lookup === "string" || lookup.kind !== "custom") return undefined;
    return {
      key,
      label: lookup.name,
      summary: summary(staffCatalogue, lookup),
      permissions: [...permissionsOf(staffCatalogue, lookup)],
    };
  }

  /** `GET /api/staff-roles`'s rows: the prebuilt roles, then the custom ones by name. */
  rows(prebuilt: readonly StandInRole[], holdersOf: (key: string) => readonly string[]) {
    const holders = (key: string) => holdersOf(key).length;
    const holderIds = (key: string) => [...holdersOf(key)].sort();
    const custom = [...this.roles.values()].sort(
      (a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id),
    );
    return [
      ...prebuilt.map((role) => ({
        key: role.key,
        kind: "prebuilt" as const,
        builtIn: true,
        label: role.label,
        description: "",
        summary: role.summary,
        topRole: role.key === staffCatalogue.topRoleKey,
        holders: holders(role.key),
        holderIds: holderIds(role.key),
        permissions: [...role.permissions],
        permissionCount: role.permissions.length,
        version: null,
      })),
      ...custom.map((role) => {
        const view = this.role(role.id) as StandInRole;
        return {
          key: role.id,
          kind: "custom" as const,
          builtIn: false,
          label: role.name,
          description: role.description,
          summary: view.summary,
          topRole: false,
          holders: holders(role.id),
          holderIds: holderIds(role.id),
          permissions: [...view.permissions],
          permissionCount: view.permissions.length,
          version: role.version,
        };
      }),
    ];
  }

  /** Every `/api/staff-roles` route. */
  route(host: RolesHost): RoleAnswer {
    const rows = () =>
      this.rows(host.prebuilt, (key) => host.holders(key).map((holder) => holder.id));
    if (host.method === "GET" && host.path === "/api/staff-roles") {
      return host.needs("staff.read") ?? host.ok({ roles: rows() });
    }
    const one = /^\/api\/staff-roles\/([^/]+)$/.exec(host.path);
    if (host.method === "GET" && one !== null) {
      const denied = host.needs("staff.read");
      if (denied !== null) return denied;
      const found = rows().find((r) => r.key === decodeURIComponent(one[1] as string));
      return found === undefined ? host.problem("not_found") : host.ok(found);
    }
    if (host.method === "POST" && host.path === "/api/staff-roles") return this.#create(host);
    if (host.method === "PUT" && one !== null) return this.#save(host, one[1] as string);
    const del = /^\/api\/staff-roles\/([^/]+)\/delete$/.exec(host.path);
    if (host.method === "POST" && del !== null) return this.#delete(host, del[1] as string);
    return host.problem("not_found");
  }

  #actorPermissions(host: RolesHost): ReadonlySet<StaffPermission> {
    return permissionsOf(staffCatalogue, this.#lookup(host.actor.roleKey));
  }

  #draft(host: RolesHost) {
    const text = (value: unknown) => (typeof value === "string" ? normaliseRoleText(value) : "");
    const permissions = Array.isArray(host.body.permissions)
      ? host.body.permissions.filter((p): p is string => typeof p === "string")
      : [];
    return { name: text(host.body.name), description: text(host.body.description), permissions };
  }

  #check(
    host: RolesHost,
    draft: { name: string; description: string; permissions: string[] },
    others: readonly string[],
  ): RoleAnswer | null {
    const problems = validateRole(
      staffCatalogue,
      { ...draft, permissions: draft.permissions as StaffPermission[] },
      this.#actorPermissions(host),
      { takenNames: others },
    );
    if (problems.includes("beyond")) return host.problem("giving_refused", { problem: "beyond" });
    if (problems.length === 0) return null;
    return host.problem("invalid", {
      fields: problems
        .filter((p): p is Exclude<RoleProblem, "beyond"> => p !== "beyond")
        .map((p) => ({ path: FIELD[p], code: p })),
    });
  }

  /** The holders a request names (`holders`), once each and sorted; null when it names none. */
  #shown(host: RolesHost): string[] | null {
    const named = host.body.holders;
    if (!Array.isArray(named) || named.some((v) => typeof v !== "string")) return null;
    return [...new Set(named as string[])].sort();
  }

  /** Whether `shown` is exactly the role's holders now. */
  #same(host: RolesHost, id: string, shown: readonly string[]): boolean {
    const holders = host.holders(id);
    const now = holders.map((holder) => holder.id).sort();
    return shown.length === now.length && shown.every((holderId, i) => holderId === now[i]);
  }

  #known(permissions: readonly string[]): StaffPermission[] {
    return sortPermissions(
      staffCatalogue,
      permissions.filter((p): p is StaffPermission => Object.hasOwn(staffCatalogue.permissions, p)),
    );
  }

  #create(host: RolesHost): RoleAnswer {
    const denied = host.needs("staffRoles.manage");
    if (denied !== null) return denied;
    if (customRoleLimitReached(this.roles.size)) {
      return host.problem("limit_reached", { limit: CUSTOM_ROLE_LIMIT });
    }
    const draft = this.#draft(host);
    const refused = this.#check(
      host,
      draft,
      [...this.roles.values()].map((r) => r.name),
    );
    if (refused !== null) return refused;
    const stepUp = host.stepUp("staffRole.create", "staff_role.create", draft);
    if (stepUp !== null) return stepUp;
    const role: CustomRole = {
      id: newRoleId(),
      name: draft.name,
      description: draft.description,
      permissions: this.#known(draft.permissions),
      version: 1,
    };
    this.roles.set(role.id, role);
    host.record("staff.role_created", role.id, { permissions: role.permissions });
    return host.ok({ roleId: role.id, version: 1 }, 201);
  }

  #editable(host: RolesHost, id: string): CustomRole | RoleAnswer {
    const denied = host.needs("staffRoles.manage");
    if (denied !== null) return denied;
    const role = ID.test(id) ? this.roles.get(id) : undefined;
    if (role === undefined) return host.problem("not_found");
    const problem = editingProblem(staffCatalogue, {
      actorRoleKey: host.actor.roleKey,
      actorPerms: this.#actorPermissions(host),
      role: this.#lookup(id),
    });
    if (problem === "outranked") return host.problem("outranked");
    if (problem === "self") return host.problem("giving_refused", { problem: "self" });
    if (problem !== null) return host.problem("not_found");
    return role;
  }

  #save(host: RolesHost, id: string): RoleAnswer {
    const role = this.#editable(host, id);
    if ("status" in role) return role;
    const version = host.body.version;
    if (version !== role.version) return host.problem("conflict");
    const draft = this.#draft(host);
    const refused = this.#check(
      host,
      draft,
      [...this.roles.values()].filter((r) => r.id !== id).map((r) => r.name),
    );
    if (refused !== null) return refused;
    const after = this.#known(draft.permissions);
    const { added, removed } = permissionDiff(staffCatalogue, role.permissions, after);
    // The holders the editor counted: a save that adds a permission raises exactly those, or none.
    const shown = this.#shown(host);
    if (shown === null) {
      return host.problem("invalid", { fields: [{ path: "holders", code: "invalid_type" }] });
    }
    if (added.length > 0 && !this.#same(host, id, shown)) return host.problem("conflict");
    const stepUp = host.stepUp("staffRole.update", "staff_role.update", {
      target: id,
      ...draft,
      version,
      holders: shown,
    });
    if (stepUp !== null) return stepUp;
    const renamed = role.name !== draft.name;
    role.name = draft.name;
    role.description = draft.description;
    role.permissions = after;
    role.version += 1;
    host.record("staff.role_updated", id, {
      added: [...added],
      removed: [...removed],
      holders: host.holders(id).length,
      renamed,
    });
    return host.ok({ roleId: id, version: role.version });
  }

  #delete(host: RolesHost, id: string): RoleAnswer {
    const role = this.#editable(host, id);
    if ("status" in role) return role;
    const holders = host.holders(id);
    // The holders the page counted: exactly the role's holders now, or nobody moves.
    const shown = this.#shown(host);
    if (shown === null) {
      return host.problem("invalid", { fields: [{ path: "holders", code: "invalid_type" }] });
    }
    if (!this.#same(host, id, shown)) return host.problem("conflict");
    const moveTo = typeof host.body.moveTo === "string" ? host.body.moveTo : undefined;
    const problem = deletionProblem(staffCatalogue, {
      actorRoleKey: host.actor.roleKey,
      actorPerms: this.#actorPermissions(host),
      role: this.#lookup(id),
      holders: holders.length,
      invitations: 0,
      ...(moveTo === undefined ? {} : { moveTo: this.#lookup(moveTo) }),
    });
    if (problem === "outranked") return host.problem("outranked");
    if (problem === "move_forbidden") {
      return host.problem("forbidden", { permission: staffCatalogue.movePermission });
    }
    if (problem === "gone" || problem === "built_in") return host.problem("not_found");
    if (problem !== null) {
      return host.problem("giving_refused", {
        problem: problem === "move_gone" ? "gone" : problem,
      });
    }
    const stepUp = host.stepUp("staffRole.delete", "staff_role.delete", {
      target: id,
      moveTo,
      holders: shown,
    });
    if (stepUp !== null) return stepUp;
    const movedTo = holders.length > 0 && moveTo !== undefined ? moveTo : null;
    for (const holder of holders) {
      if (movedTo === null) break;
      host.move(holder.id, movedTo);
      host.record("staff.role_changed", holder.id, {
        fromRole: id,
        toRole: movedTo,
        reason: "role_deleted",
      });
    }
    this.roles.delete(id);
    host.record("staff.role_deleted", id, { movedTo, membersMoved: holders.length });
    return host.ok({ roleId: id, movedTo, membersMoved: holders.length });
  }
}
