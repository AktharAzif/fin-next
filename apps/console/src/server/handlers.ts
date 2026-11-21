// The handler of each route of the console's policy (spec 02 §14.2). A handler runs its guard and its
// action in one unit of work: `person()` for person-scope routes (the session, the gate, the
// step-up), `actor()` for organisation routes (`requireActor`: `Fin-Organization`, the membership,
// the role's permissions read now, the team-change lock). The policy entry is the only source of
// each route's permission, step-up, reach and lock, so the router and its tests cannot disagree.
import {
  AuthRefusal,
  codeLinkAsking,
  finCookieName,
  readCookie,
  serializeFinCookie,
  signUp,
  type UnitTx,
} from "@fin/identity";
import {
  type AuditLogQuery,
  acceptInvitation,
  cancelInvitation,
  changeInvitation,
  changeMemberRole,
  createFirstOrganization,
  createOrganization,
  createRole,
  declineInvitation,
  deleteOrganization,
  deleteRole,
  type Guarded,
  getRole,
  invitationFromCookie,
  inviteMember,
  listOrganizations,
  listRoles,
  memberCredentials,
  myInvitations,
  type OrgActor,
  OrgRefusal,
  openInvitation,
  organisationLog,
  organizationProfile,
  personActivity,
  personGuard,
  type RealmState,
  removeMember,
  renameOrganization,
  requireActor,
  resendInvitation,
  type StepUpRule,
  switchOrganization,
  teamList,
  updateRole,
} from "@fin/orgs";
import {
  accountPasskeys,
  accountSecurity,
  accountSessions,
  changeName,
  revokeOneSession,
  revokeOthers,
  revokeTrustedBrowser,
} from "./account.ts";
import { isTimeZone } from "./policy/schemas.ts";
import type { ConsoleDeps, RouteInput } from "./routes.ts";
import { viewerOf } from "./viewer.ts";

export interface RouteAnswer {
  status: number;
  body?: unknown;
  setCookies?: readonly string[];
}

export type Handler = (input: RouteInput, deps: ConsoleDeps) => Promise<RouteAnswer>;

function ruleOf(input: RouteInput): StepUpRule {
  const { policy } = input;
  const action = policy.action ?? "";
  switch (policy.stepUp) {
    case "none":
      return { kind: "none" };
    case "window":
      return { kind: "window", action };
    case "intent":
      return { kind: "intent", action };
    case "intent_if_factor":
      return { kind: "intent_if_factor", action };
  }
}

/** A person-scope route's unit of work: the guard, then the action. */
function person<T>(
  input: RouteInput,
  deps: ConsoleDeps,
  fn: (tx: UnitTx, who: Guarded, state: RealmState) => Promise<T>,
): Promise<T> {
  return deps.orgs.realm.run(input.context, async (tx, state) => {
    const who = await personGuard(deps.orgs.realm, input.request, input.context, tx, state, {
      stepUp: ruleOf(input),
      ...(input.policy.reach === undefined ? {} : { reach: input.policy.reach }),
    });
    input.cookies.push(...who.setCookies);
    return fn(tx, who, state);
  });
}

/** An organisation route's unit of work: `requireActor`, then the action. */
function actor<T>(
  input: RouteInput,
  deps: ConsoleDeps,
  fn: (tx: UnitTx, actor: OrgActor) => Promise<T>,
): Promise<T> {
  const { policy } = input;
  return deps.orgs.realm.run(input.context, async (tx, state) => {
    const who = await requireActor(deps.orgs.realm, input.request, input.context, tx, state, {
      stepUp: ruleOf(input),
      ...(policy.permission === undefined ? {} : { permission: policy.permission }),
      ...(policy.anyOf === undefined ? {} : { anyOf: policy.anyOf }),
      ...(policy.reach === undefined ? {} : { reach: policy.reach }),
      lock: policy.lock === true,
    });
    input.cookies.push(...who.setCookies);
    return fn(tx, who);
  });
}

/** The signed-in person for a public route, if any (the invitation's `state`). */
async function optionalViewer(
  input: RouteInput,
  deps: ConsoleDeps,
  state: RealmState,
): Promise<{ email: string } | null> {
  await deps.orgs.realm.api.getSession({ headers: input.request.headers });
  return state.prior === null ? null : { email: state.prior.person.email };
}

const ok = (body: unknown, status = 200): RouteAnswer => ({ status, body });

function pageOf(input: RouteInput): { page: number; size: number } {
  return { page: Number(input.query.page ?? 1), size: Number(input.query.size ?? 25) };
}

const INVITATION_COOKIE = finCookieName("developer", "invitation");

export const HANDLERS = {
  async signUp(input, deps) {
    const answer = await signUp(deps.orgs.realm, input.request, input.context, {
      name: input.body.name,
      email: input.body.email,
    });
    return { status: answer.status, body: answer.body, setCookies: answer.setCookies };
  },

  async codeLink(input, deps) {
    const realm = deps.orgs.realm;
    const asking = await realm.run(input.context, async (tx, state) => {
      const limit = await realm.runtime.limits.consume(
        tx,
        "code_sign_in",
        realm.runtime.hasher.bucket("network", state.network),
      );
      if (!limit.allowed) {
        throw new AuthRefusal("rate_limited", "limits.code_sign_in", {
          retry_after: limit.retryAfter,
        });
      }
      return codeLinkAsking(
        tx,
        { clock: realm.runtime.clock, hasher: realm.runtime.hasher },
        String(input.body.email),
        readCookie(input.request.headers.get("cookie"), finCookieName("developer", "code_browser")),
      );
    });
    return ok({ asking });
  },

  async viewer(input, deps) {
    return ok(await person(input, deps, (tx, who) => viewerOf(deps.orgs, tx, who)));
  },

  async viewerOrganization(input, deps) {
    await person(input, deps, (tx, who) =>
      switchOrganization(deps.orgs, tx, who, String(input.body.orgId)),
    );
    return ok({ orgId: input.body.orgId });
  },

  async invitationOpen(input, deps) {
    const realm = deps.orgs.realm;
    const opened = await realm.run(input.context, async (tx, state) =>
      openInvitation(
        deps.orgs,
        tx,
        String(input.body.token),
        await optionalViewer(input, deps, state),
      ),
    );
    return {
      status: 200,
      body: opened.view,
      setCookies: [serializeFinCookie("developer", "invitation", opened.cookie)],
    };
  },

  async invitationCurrent(input, deps) {
    const realm = deps.orgs.realm;
    const view = await realm.run(input.context, async (tx, state) =>
      invitationFromCookie(
        deps.orgs,
        tx,
        readCookie(input.request.headers.get("cookie"), INVITATION_COOKIE),
        await optionalViewer(input, deps, state),
      ),
    );
    return ok(view);
  },

  async invitationsMine(input, deps) {
    return ok({
      invitations: await person(input, deps, (tx, who) => myInvitations(deps.orgs, tx, who)),
    });
  },

  async invitationAccept(input, deps) {
    const joined = await person(input, deps, (tx, who) =>
      acceptInvitation(deps.orgs, tx, who, String(input.params.invitationId)),
    );
    return {
      status: 200,
      body: joined,
      // The invitation is answered: the cookie that carried it goes.
      setCookies: [serializeFinCookie("developer", "invitation", null)],
    };
  },

  async invitationDecline(input, deps) {
    const declined = await person(input, deps, (tx, who) =>
      declineInvitation(deps.orgs, tx, who, String(input.params.invitationId)),
    );
    return {
      status: 200,
      body: declined,
      setCookies: [serializeFinCookie("developer", "invitation", null)],
    };
  },

  async accountSecurity(input, deps) {
    return ok(await person(input, deps, (tx, who) => accountSecurity(tx, who)));
  },

  async accountPasskeys(input, deps) {
    return ok(await person(input, deps, (tx, who) => accountPasskeys(tx, who, pageOf(input))));
  },

  async accountSessions(input, deps) {
    return ok(await person(input, deps, (tx, who) => accountSessions(tx, who, pageOf(input))));
  },

  async accountActivity(input, deps) {
    return ok(await person(input, deps, (tx, who) => personActivity(tx, who, pageOf(input))));
  },

  async accountName(input, deps) {
    return ok(
      await person(input, deps, (tx, who) =>
        changeName(deps.orgs, tx, who, { name: String(input.body.name) }),
      ),
    );
  },

  async sessionRevoke(input, deps) {
    return ok(
      await person(input, deps, (tx, who) =>
        revokeOneSession(deps.orgs, tx, who, input.request, String(input.params.sessionId)),
      ),
    );
  },

  async sessionsRevokeOthers(input, deps) {
    return ok(
      await person(input, deps, (tx, who) => revokeOthers(deps.orgs, tx, who, input.request)),
    );
  },

  async trustedBrowserRevoke(input, deps) {
    return ok(
      await person(input, deps, (tx, who) =>
        revokeTrustedBrowser(deps.orgs, tx, who, String(input.params.browserId)),
      ),
    );
  },

  async orgsList(input, deps) {
    return ok(await person(input, deps, (tx, who) => listOrganizations(tx, who, pageOf(input))));
  },

  async orgsCreate(input, deps) {
    return ok(
      await person(input, deps, (tx, who) =>
        createOrganization(deps.orgs, tx, who, { name: String(input.body.name) }),
      ),
      201,
    );
  },

  async orgsFirst(input, deps) {
    return ok(
      await person(input, deps, (tx, who) => createFirstOrganization(deps.orgs, tx, who)),
      201,
    );
  },

  async orgGet(input, deps) {
    return ok(await actor(input, deps, async (_tx, a) => organizationProfile(a)));
  },

  async orgRename(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        renameOrganization(deps.orgs, tx, a, { name: String(input.body.name) }),
      ),
    );
  },

  async orgDelete(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        deleteOrganization(deps.orgs, tx, a, { confirmName: String(input.body.confirmName) }),
      ),
    );
  },

  async team(input, deps) {
    const query = input.query as { q?: string; page: number; size: number };
    return ok(
      await actor(input, deps, (tx, a) =>
        teamList(deps.orgs, tx, a, { q: query.q, page: query.page, size: query.size }),
      ),
    );
  },

  async memberCredentials(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        memberCredentials(deps.orgs, tx, a, String(input.params.memberId)),
      ),
    );
  },

  async memberRole(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        changeMemberRole(deps.orgs, tx, a, String(input.params.memberId), {
          roleKey: String(input.body.roleKey),
          rollCredentials: input.body.rollCredentials === true,
        }),
      ),
    );
  },

  async memberRemove(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        removeMember(deps.orgs, tx, a, String(input.params.memberId), {
          rollCredentials: input.body.rollCredentials === true,
        }),
      ),
    );
  },

  async invite(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        inviteMember(deps.orgs, tx, a, {
          email: String(input.body.email),
          roleKey: String(input.body.roleKey),
        }),
      ),
      201,
    );
  },

  async invitationChange(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        changeInvitation(deps.orgs, tx, a, String(input.params.invitationId), {
          roleKey: String(input.body.roleKey),
        }),
      ),
    );
  },

  async invitationResend(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        resendInvitation(deps.orgs, tx, a, String(input.params.invitationId)),
      ),
    );
  },

  async invitationCancel(input, deps) {
    return ok(
      await actor(input, deps, (tx, a) =>
        cancelInvitation(deps.orgs, tx, a, String(input.params.invitationId)),
      ),
    );
  },

  async roles(input, deps) {
    return ok(await actor(input, deps, (tx, a) => listRoles(tx, a)));
  },

  async role(input, deps) {
    return ok(await actor(input, deps, (tx, a) => getRole(tx, a, String(input.params.roleKey))));
  },

  async roleCreate(input, deps) {
    const body = input.body as { name: string; description: string; permissions: string[] };
    return ok(await actor(input, deps, (tx, a) => createRole(deps.orgs, tx, a, body)), 201);
  },

  async roleUpdate(input, deps) {
    const body = input.body as {
      name: string;
      description: string;
      permissions: string[];
      version: number;
    };
    return ok(
      await actor(input, deps, (tx, a) =>
        updateRole(deps.orgs, tx, a, String(input.params.roleId), body),
      ),
    );
  },

  async roleDelete(input, deps) {
    const moveTo = typeof input.body.moveTo === "string" ? input.body.moveTo : undefined;
    return ok(
      await actor(input, deps, (tx, a) =>
        deleteRole(deps.orgs, tx, a, String(input.params.roleId), { moveTo }),
      ),
    );
  },

  async auditLog(input, deps) {
    const q = input.query as {
      q?: string;
      type?: AuditLogQuery["type"];
      range: AuditLogQuery["range"];
      from?: string;
      to?: string;
      tz: string;
      target?: string;
      targetKind?: "role";
      page: number;
      size: number;
    };
    const fields: { path: string; code: string }[] = [];
    if (!isTimeZone(q.tz)) fields.push({ path: "query.tz", code: "invalid_time_zone" });
    if ((q.page - 1) * q.size > 10_000) fields.push({ path: "query.page", code: "too_big" });
    if (fields.length > 0) {
      throw new OrgRefusal("invalid", "schema.invalid", { fields });
    }
    return ok(
      await actor(input, deps, (tx, a) =>
        organisationLog(
          tx,
          a,
          {
            q: q.q,
            type: q.type,
            range: q.range,
            from: q.from === undefined ? undefined : new Date(q.from),
            to: q.to === undefined ? undefined : new Date(q.to),
            tz: q.tz,
            page: q.page,
            size: q.size,
            target: q.target,
            targetKind: q.targetKind,
          },
          deps.orgs.clock.now(),
        ),
      ),
    );
  },
} satisfies Record<string, Handler>;
