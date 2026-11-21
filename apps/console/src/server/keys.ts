// The console's API keys routes (spec 02 §12.3; spec 05 §4.6), on @fin/keys's lifecycle. Each runs
// `requireActor` (the session, `Fin-Organization`, the membership and the role's permissions read
// now, the team-change lock), then the lifecycle's own checks, then the step-up intent bound to the
// action, the key and its fields, then the change, its audit event and its notices, in one unit of
// work. A lifecycle refusal answers as the organisation area's problems do.
//
// Settings, read once inside main(): FIN_KEY_SALT (this environment's salt, spec 05 §4.1) and
// API_KEY_PEPPER_<n> with API_KEY_PEPPER_IN_USE (spec 08 §6). Both are required on staging and in
// production (exit 78 naming the variable); a development or CI process started without either
// answers the key routes `503 unavailable`, so the other areas' tests need neither.
import { AuthRefusal, type LineSink, type UnitTx } from "@fin/identity";
import {
  createKey,
  createKeys,
  isKeyRefusal,
  type KeyActor,
  type KeyEnvironment,
  type KeyMode,
  type Keys,
  keySettingsAbsent,
  keySettingsFromEnv,
  keysOfMember,
  listKeys,
  type MemberKey,
  revokeKey,
  rollForMember,
  rollKey,
  updateKey,
} from "@fin/keys";
import {
  type CredentialSource,
  customRolesOf,
  lookupRole,
  type OrgActor,
  type OrgAuditActor,
  OrgRefusal,
  type Orgs,
  permissionsFor,
  requireActor,
  type StepUpRule,
} from "@fin/orgs";
import type { Env, Environment } from "@fin/server/config";
import type { RouteAnswer } from "./handlers.ts";
import type { ConsoleDeps, RouteInput } from "./routes.ts";

/** The console's keys settings, or null when a development or CI process has none (see the head). */
export function keysOf(
  env: Env,
  environment: Environment,
  deps: { clock: { now(): Date }; lines: LineSink },
): Keys | null {
  const optional = environment === "development" || environment === "ci";
  if (optional && keySettingsAbsent(env)) return null;
  const settings = keySettingsFromEnv(env, environment as KeyEnvironment);
  return createKeys({
    clock: deps.clock,
    peppers: settings.peppers,
    salt: settings.salt,
    lines: { write: (event, level, fields) => deps.lines.write(event, level, fields as never) },
  });
}

function ruleOf(input: RouteInput): StepUpRule {
  return input.policy.stepUp === "intent"
    ? { kind: "intent", action: input.policy.action ?? "" }
    : { kind: "none" };
}

/** The organisation route's unit of work for a key route: `requireActor`, then the key work. */
function withActor<T>(
  input: RouteInput,
  deps: ConsoleDeps,
  fn: (tx: UnitTx, actor: OrgActor, keys: Keys) => Promise<T>,
): Promise<T> {
  const keys = deps.keys;
  const { policy } = input;
  return deps.orgs.realm.run(input.context, async (tx, state) => {
    const who = await requireActor(deps.orgs.realm, input.request, input.context, tx, state, {
      stepUp: ruleOf(input),
      ...(policy.permission === undefined ? {} : { permission: policy.permission }),
      ...(policy.anyOf === undefined ? {} : { anyOf: policy.anyOf }),
      lock: policy.lock === true,
    });
    input.cookies.push(...who.setCookies);
    // The session, the membership and the permission answer first; then a process with no keys
    // settings (development or CI only) says so.
    if (keys === null || keys === undefined) {
      throw new AuthRefusal("unavailable", "keys.not_configured", { retry_after: 60 });
    }
    try {
      return await fn(tx, who, keys);
    } catch (error) {
      if (isKeyRefusal(error)) {
        throw new OrgRefusal(error.code, error.lineReason, error.extensions);
      }
      throw error;
    }
  });
}

/** The lifecycle's actor, from `requireActor`'s; the audit actor is shared, so a proved step-up shows. */
export function keyActorOf(a: OrgActor): KeyActor {
  return {
    userId: a.person.id,
    organizationId: a.organization.id,
    organizationName: a.organization.name,
    organizationLiveStatus: a.organization.liveStatus,
    permissions: a.permissions,
    audit: a.actor,
    context: a.context,
    confirm: (binding) =>
      a.confirm({ body: binding.body, target: binding.target, organizationId: a.organization.id }),
  };
}

/** Each maker's permissions in the organisation now, or null for one who is no longer a member. */
async function makerPermissions(
  tx: UnitTx,
  organizationId: string,
  userIds: string[],
): Promise<Map<string, ReadonlySet<string> | null>> {
  const out = new Map<string, ReadonlySet<string> | null>(userIds.map((id) => [id, null]));
  if (userIds.length === 0) return out;
  const members = await tx.query<{ user_id: string; role_key: string }>(
    "SELECT user_id, role_key FROM identity.member WHERE organization_id = $1 AND user_id = ANY ($2::text[])",
    [organizationId, userIds],
  );
  const roles = await customRolesOf(tx, organizationId);
  for (const m of members.rows) out.set(m.user_id, permissionsFor(lookupRole(roles, m.role_key)));
  return out;
}

const ok = (body: unknown, status = 200): RouteAnswer => ({ status, body });

export const KEYS_HANDLERS = {
  async keysList(input, deps) {
    const query = input.query as { mode: KeyMode; page: number; size: number };
    return ok(
      await withActor(input, deps, (tx, a) =>
        listKeys(tx, keyActorOf(a), query, (ids) => makerPermissions(tx, a.organization.id, ids)),
      ),
    );
  },

  async keysCreate(input, deps) {
    const body = input.body as unknown as Parameters<typeof createKey>[3];
    return ok(
      await withActor(input, deps, (tx, a, keys) => createKey(keys, tx, keyActorOf(a), body)),
      201,
    );
  },

  async keysUpdate(input, deps) {
    const body = input.body as unknown as Parameters<typeof updateKey>[4];
    const keyId = String(input.params.keyId);
    return ok({
      key: await withActor(input, deps, (tx, a, keys) =>
        updateKey(keys, tx, keyActorOf(a), keyId, body),
      ),
    });
  },

  async keysRoll(input, deps) {
    const body = input.body as unknown as Parameters<typeof rollKey>[4];
    const keyId = String(input.params.keyId);
    return ok(
      await withActor(input, deps, (tx, a, keys) => rollKey(keys, tx, keyActorOf(a), keyId, body)),
    );
  },

  async keysRevoke(input, deps) {
    const keyId = String(input.params.keyId);
    return ok({
      key: await withActor(input, deps, (tx, a, keys) => revokeKey(keys, tx, keyActorOf(a), keyId)),
    });
  },
} satisfies Record<string, (input: RouteInput, deps: ConsoleDeps) => Promise<RouteAnswer>>;

/**
 * API keys as a credential source of the organisation area's registry (spec 02 §9.4, IF-07): every
 * key a leaving or demoted member made or was shown that the edge still accepts, an old key inside a
 * roll's overlap included, rolled in the removal's transaction (an old key's overlap is cut). A
 * Sandbox key rolls at once for an actor holding apiKey.sandbox, a Production key for one holding
 * apiKey.live; otherwise with a 1-hour overlap (S2-42).
 */
export function apiKeyCredentials(keys: Keys): CredentialSource {
  return {
    kind: "api_key",
    list: async (tx, orgId, userId) => keysOfMember(tx, orgId, userId),
    rollPermission: (item) =>
      (item as Partial<MemberKey>).mode === "test" ? "apiKey.sandbox" : "apiKey.live",
    roll: async (tx, orgId, ids, overlap, actor: OrgAuditActor) => {
      const org = await tx.query<{ name: string }>(
        "SELECT name FROM identity.organization WHERE id = $1",
        [orgId],
      );
      await rollForMember(
        keys,
        tx,
        { id: orgId, name: org.rows[0]?.name ?? "" },
        ids,
        overlap,
        actor,
      );
    },
  };
}

export type { Orgs };
