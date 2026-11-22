// `databaseHooks` (spec 02 §3.5): Fin's session fields on every session the library makes, the
// absolute limit no refresh passes, and who may create an account.

import { FACTOR_STEP_LIFETIME_MS } from "../gate.ts";
import {
  googleAccountCreate,
  googleAccountUpdateDropped,
  googleSessionFields,
  googleUserFields,
  isCallbackPath,
} from "../google/hooks.ts";
import { staffGoogleSessionFields } from "../google/staff.ts";
import { DAY, HOUR } from "../ports/clock.ts";
import { type RealmRuntime, requestState, unitOf } from "../runtime.ts";
import type { SessionRow } from "../store.ts";

const ABSOLUTE_MS = { developer: 7 * DAY, staff: 12 * HOUR } as const;
const IDLE_MS = { developer: DAY, staff: HOUR } as const;

type Data = Record<string, unknown>;
interface HookEndpoint {
  path?: string;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function clip(value: unknown, max: number): string | null {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : null;
}

/**
 * What a developer session's replacement carries over from the session it replaces (§11.3): the
 * mailbox proof, the organisation the viewer is in, and the trusted browser while its row is still
 * live. A new session (`null`) starts with none of them.
 */
function inherited(old: SessionRow | null): Data {
  return {
    mailboxProvedAt: old?.mailboxProvedAt ?? null,
    currentOrganizationId: old?.currentOrganizationId ?? null,
    trustedBrowserId: old?.trustedBrowserLive === true ? old.trustedBrowserId : null,
  };
}

export function databaseHooks(rt: RealmRuntime) {
  const realm = rt.settings.realm;

  /** Fin's fields for a new session, by the path that made it; any other path fails closed. */
  async function sessionCreate(session: Data, ctx: HookEndpoint | null): Promise<{ data: Data }> {
    const state = requestState(rt);
    const now = rt.clock.now();
    const path = ctx?.path ?? "";
    const prior = state.prior;
    const userId = String(session.userId ?? "");
    const base: Data = {
      ipAddress: clip(session.ipAddress, 64),
      userAgent: clip(session.userAgent, 400),
      stepUpFailures: 0,
    };
    let fields: Data;
    if (path === "/sign-in/email-otp") {
      const absolute = new Date(now.getTime() + ABSOLUTE_MS[realm]);
      if (realm === "developer") {
        const signIn = state.signIn;
        const trusted = signIn?.trustedBrowserId ?? null;
        const atFactorStep = (signIn?.facts?.factorCount ?? 0) > 0 && trusted === null;
        fields = {
          assurance: "aal1",
          createdVia: "email_otp",
          mailboxProvedAt: now,
          trustedBrowserId: trusted,
          absoluteExpiresAt: absolute,
          expiresAt: new Date(
            now.getTime() + (atFactorStep ? FACTOR_STEP_LIFETIME_MS : IDLE_MS[realm]),
          ),
        };
      } else {
        const access = state.context.access;
        if (access === null || access === undefined)
          throw new Error("staff session without an Access identity");
        fields = {
          assurance: "aal1",
          createdVia: "email_otp",
          accessSub: access.sub,
          enrolmentOpenUntil: null,
          absoluteExpiresAt: absolute,
          expiresAt: new Date(now.getTime() + FACTOR_STEP_LIFETIME_MS),
        };
      }
    } else if (path === "/passkey/verify-authentication") {
      const replaces = prior !== null && prior.person.id === userId;
      const absolute = replaces
        ? prior.session.absoluteExpiresAt
        : new Date(now.getTime() + ABSOLUTE_MS[realm]);
      fields = {
        assurance: "aal2",
        createdVia: replaces ? "replacement" : "passkey",
        absoluteExpiresAt: absolute,
        expiresAt: earlier(new Date(now.getTime() + IDLE_MS[realm]), absolute),
      };
      if (realm === "developer") {
        Object.assign(fields, replaces ? inherited(prior.session) : inherited(null));
      } else {
        const access = state.context.access;
        if (access === null || access === undefined)
          throw new Error("staff session without an Access identity");
        fields.accessSub = access.sub;
        fields.enrolmentOpenUntil = null;
      }
    } else if (realm === "developer" && isCallbackPath(path)) {
      // Google (§5.8, §6.1): `aal1`, at the factor step when the person has a factor.
      fields = await googleSessionFields(rt, state, unitOf(rt), userId);
    } else if (realm === "staff" && isCallbackPath(path)) {
      // Staff Google (§5.8): `aal1` under the request's Access identity, like an emailed code.
      fields = staffGoogleSessionFields(rt, state);
    } else if (
      (path === "/two-factor/verify-totp" || path === "/two-factor/disable") &&
      prior !== null &&
      prior.person.id === userId
    ) {
      // The plugin replaces the session when an authenticator is finished or turned off; the
      // replacement keeps everything of the old one, its absolute limit included (S2-12). Only
      // finishing a set-up from a session that may enrol raises it (the before-hook refuses the
      // factor step's attempt); anything else keeps the old session's assurance.
      const raises = path === "/two-factor/verify-totp" && state.finishingAuthenticator;
      fields = {
        assurance: raises ? "aal2" : prior.session.assurance,
        createdVia: "replacement",
        absoluteExpiresAt: prior.session.absoluteExpiresAt,
        expiresAt: earlier(
          new Date(now.getTime() + IDLE_MS[realm]),
          prior.session.absoluteExpiresAt,
        ),
        stepUpFailures: prior.session.stepUpFailures,
      };
      if (realm === "developer") {
        Object.assign(fields, inherited(prior.session));
      } else {
        fields.accessSub = prior.session.accessSub;
        fields.enrolmentOpenUntil = prior.session.enrolmentOpenUntil;
      }
    } else {
      throw new Error(
        `identity: a session may not be created from ${path === "" ? "a server call" : path}`,
      );
    }
    return { data: { ...session, ...base, ...fields } };
  }

  /** No refresh passes the absolute limit, and a factor-step session is never extended (§11). */
  async function sessionUpdate(update: Data): Promise<{ data: Data }> {
    if (!("expiresAt" in update)) return { data: update };
    const state = requestState(rt);
    const prior = state.prior;
    const next = update.expiresAt instanceof Date ? update.expiresAt : null;
    const { expiresAt: _dropped, ...rest } = update;
    if (
      prior === null ||
      next === null ||
      state.gate === "factor_step" ||
      state.gate === "pending"
    ) {
      return { data: rest };
    }
    return { data: { ...rest, expiresAt: earlier(next, prior.session.absoluteExpiresAt) } };
  }

  async function userCreate(user: Data, ctx: HookEndpoint | null): Promise<{ data: Data }> {
    const state = requestState(rt);
    if (realm === "developer" && isCallbackPath(ctx?.path ?? "")) {
      // A Google sign-up (§5.8): a verified address, sign-ups open, the velocity limits.
      return { data: await googleUserFields(rt, state, unitOf(rt), user) };
    }
    const signIn = state.signIn;
    if (
      realm !== "developer" ||
      ctx?.path !== "/sign-in/email-otp" ||
      signIn === null ||
      !signIn.askingBrowser
    ) {
      // Staff rows are made only by Fin's staff routes; developers only by a code sign-in in the
      // browser that asked (§5.1, S2-22).
      throw new Error("identity: this path may not create an account");
    }
    if ((await rt.killSwitch(unitOf(rt), "signups")) === "on") {
      throw new Error("identity: sign-ups are paused");
    }
    return {
      data: {
        ...user,
        email: String(user.email ?? "").toLowerCase(),
        emailVerified: true,
        name: signIn.signUpName ?? "",
        image: null,
      },
    };
  }

  async function userCreated(user: Data): Promise<void> {
    const state = requestState(rt);
    if (typeof user.id === "string") state.createdUserId = user.id;
  }

  /** A Google account row keeps no provider token; only the callback makes one (§5.8). */
  async function accountCreate(account: Data, ctx: HookEndpoint | null): Promise<{ data: Data }> {
    const stripped = googleAccountCreate(requestState(rt), ctx?.path ?? "", account);
    return { data: stripped ?? account };
  }

  /** The library's token refresh of a Google row on a re-link changes nothing Fin keeps. */
  async function accountUpdate(update: Data): Promise<{ data: Data } | false> {
    return googleAccountUpdateDropped(update) ? false : { data: update };
  }

  return {
    session: {
      create: { before: sessionCreate },
      update: { before: sessionUpdate },
    },
    user: {
      create: { before: userCreate, after: userCreated },
    },
    account: {
      create: { before: accountCreate },
      update: { before: accountUpdate },
    },
  };
}
