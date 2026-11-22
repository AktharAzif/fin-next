// createRealm() (spec 02 §3.2, [SA-01]): one factory builds both realms with the same hardening.
// It is called once per process inside main(), never at module scope.
//
// A realm request runs like this: the exact allowlist (§4) answers 404 for anything unlisted or
// blocked before the router and before any limit is counted; then one unit of work is opened and
// bound, the library runs inside it with Fin's hooks, the answer is read in full, and the unit
// commits before a byte is sent. A refused commit (an audit guard) discards the answer.
import { AsyncLocalStorage } from "node:async_hooks";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { emailOTP, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import { createRecordAudit, type RecordAudit } from "./audit/record.ts";
import { expectedTrustedOrigins, type RealmSettings } from "./config.ts";
import {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  generateBackupCodes,
} from "./crypto/backup-codes.ts";
import { KeyedHasher } from "./crypto/keyed.ts";
import { createEmailEnqueue, type EmailEnqueue } from "./email/enqueue.ts";
import {
  authPathOf,
  createEndpointPolicy,
  type EndpointPolicy,
  type EndpointRule,
} from "./endpoint-policy.ts";
import { AuthRefusal, problemResponse } from "./errors.ts";
import { googleCallbackLocation, googleRequestRefusal } from "./google/hooks.ts";
import { finGooglePlugin } from "./google/plugin.ts";
import { createGoogleSignIn, type GoogleSignIn } from "./google/provider.ts";
import { staffGoogleRequestRefusal } from "./google/staff.ts";
import { claimState, type StateClaim } from "./google/state.ts";
import { afterHook } from "./hooks/after.ts";
import { beforeHook } from "./hooks/before.ts";
import type { HookContext } from "./hooks/context.ts";
import { databaseHooks } from "./hooks/database.ts";
import { createLimitStore, type LimitStore, LimitStoreError } from "./limits.ts";
import type { Clock } from "./ports/clock.ts";
import { AuditGuardError, UnitRolledBackError, type UnitTx } from "./ports/db.ts";
import { ID_PREFIXES, type IdPrefix, newId } from "./ports/ids.ts";
import { type LineSink, type LineValue, safeLineFields } from "./ports/log.ts";
import type { PgFinDatabase } from "./ports/pg-database.ts";
import { newRequestState, type RequestContext, type RequestState } from "./request.ts";
import {
  type KillSwitchReader,
  type RealmRuntime,
  readKillSwitch,
  requestState,
  unitOf,
} from "./runtime.ts";
import { developerSchema, staffSchema } from "./schema/tables.ts";
import { stepUpCatalogue } from "./step-up/actions/index.ts";
import type { StepUpAction } from "./step-up/types.ts";

export interface RealmDeps {
  settings: RealmSettings;
  /** The process pool's unit of work (packages/db, P0-E). */
  db: PgFinDatabase;
  clock: Clock;
  lines: LineSink;
  /** `https://developer.<zone>`, the base of every problem `type` (spec 01 §4.4). */
  docsOrigin: string;
  audit?: RecordAudit;
  email?: EmailEnqueue;
  limits?: LimitStore;
  killSwitch?: KillSwitchReader;
  /** Other areas' step-up action fragments (IF-03). */
  actions?: readonly (readonly StepUpAction[])[];
  /** The outbound fetch for Google's token and key endpoints (the global one by default). */
  fetch?: typeof fetch;
}

export interface RealmSession {
  session: { id: string; userId: string; expiresAt: Date };
  user: { id: string; email: string; name: string };
  /** `Set-Cookie` values a refresh produced, to copy onto the answer (§11.2). */
  setCookies: string[];
}

/**
 * The library's server API. Its own types are generic over the options, which this factory builds
 * at run time; Fin's routes call only a few endpoints, each through `run`.
 */
export type AuthEndpoint = ((input?: Record<string, unknown>) => Promise<unknown>) & {
  path?: string;
  options?: unknown;
};

export interface AuthApi {
  readonly getSession: AuthEndpoint;
  readonly sendVerificationOTP: AuthEndpoint;
  readonly [name: string]: AuthEndpoint | undefined;
}

export interface Realm {
  readonly settings: RealmSettings;
  readonly policy: EndpointPolicy;
  /** The library's server API, for Fin's own routes (always inside `run`). */
  readonly api: AuthApi;
  /** The built library instance; tests read its resolved context (SP-10). */
  readonly auth: ReturnType<typeof betterAuth>;
  readonly runtime: RealmRuntime;
  /** Answers `/api/auth/*` behind the allowlist. */
  handler(request: Request, context: RequestContext): Promise<Response>;
  /** Reads (and refreshes) the request's session, inside the caller's unit of work. */
  sessionOf(request: Request, context: RequestContext): Promise<RealmSession | null>;
  /** Runs `fn` as part of a realm request: in a unit of work, with the request state bound. */
  run<T>(context: RequestContext, fn: (tx: UnitTx, state: RequestState) => Promise<T>): Promise<T>;
}

const BASE_PATH = "/api/auth";
/** The one callback path Google comes back to, after `/api/auth` (§4.2, §5.8). */
const GOOGLE_CALLBACK = "/callback/google";

function idPrefixFor(realm: RealmSettings["realm"], model: string): IdPrefix {
  switch (model) {
    case "user":
    case "member":
      return realm === "developer" ? ID_PREFIXES.user : ID_PREFIXES.staffMember;
    case "session":
      return realm === "developer" ? ID_PREFIXES.session : ID_PREFIXES.staffSession;
    case "account":
      return ID_PREFIXES.account;
    case "verification":
      return ID_PREFIXES.verification;
    case "passkey":
      return ID_PREFIXES.passkey;
    case "twoFactor":
      return ID_PREFIXES.twoFactor;
    default:
      throw new Error(`identity: no ID prefix for the library model ${model}`);
  }
}

const internal = { input: false, required: false } as const;

/** Builds the library options for a realm (§3.3, §3.4); exported for the configuration test. */
export function buildAuthOptions(
  rt: RealmRuntime,
  db: PgFinDatabase,
  google: GoogleSignIn | null = null,
): BetterAuthOptions {
  const { settings } = rt;
  const developer = settings.realm === "developer";
  const schema = developer ? developerSchema : staffSchema;
  const client = drizzle(db.libraryClient as never, { schema });
  const reachable = rt.policy.rules.filter((r) => r.class !== "blocked" && !r.path.includes(":"));
  const before = createAuthMiddleware(async (ctx) => beforeHook(rt, ctx as unknown as HookContext));
  const after = createAuthMiddleware(async (ctx) => {
    await afterHook(rt, ctx as unknown as HookContext);
  });

  const sendVerificationOTP = async ({
    email,
    otp,
    type,
  }: {
    email: string;
    otp: string;
    type: string;
  }) => {
    const state = requestState(rt);
    const tx = unitOf(rt);
    if (type !== "sign-in") throw new Error("identity: only sign-in codes are sent");
    await rt.email(tx, {
      template: developer ? `identity/${state.codeTemplate}` : "staff/staff-sign-in-code",
      to: email,
      params: { code: otp },
    });
  };

  return {
    appName: settings.appName,
    baseURL: settings.apiOrigin ?? settings.publicOrigin,
    basePath: BASE_PATH,
    secrets: settings.secrets.map((s) => ({ version: s.version, value: s.value })),
    trustedOrigins: [settings.publicOrigin],
    telemetry: { enabled: false },
    database: drizzleAdapter(client, { provider: "pg", schema, transaction: true }),
    user: developer
      ? {}
      : {
          modelName: "member",
          additionalFields: {
            roleKey: { type: "string", ...internal },
            status: { type: "string", ...internal },
            factorEnrolledAt: { type: "date", ...internal },
            addedBy: { type: "string", ...internal },
            lastSignedInAt: { type: "date", ...internal },
            removedAt: { type: "date", ...internal },
          },
        },
    session: {
      expiresIn: developer ? 86_400 : 3_600,
      updateAge: developer ? 600 : 300,
      // The library's own "fresh session" rule (a session made in the last day) is off in both
      // realms: on the reachable paths it guards (`/unlink-account`, passkey registration) Fin's
      // step-up intent (§7.6) and first-factor rule (§6.3) are the freshness proof, and the others
      // (`/list-sessions`, `/delete-user`) are blocked (§4.2). A developer session lives up to 7
      // days (§11.1), so the library's rule would refuse those paths after a passed step-up.
      freshAge: 0,
      cookieCache: { enabled: false },
      additionalFields: developer
        ? {
            assurance: { type: "string", ...internal },
            absoluteExpiresAt: { type: "date", ...internal },
            createdVia: { type: "string", ...internal },
            mailboxProvedAt: { type: "date", ...internal },
            trustedBrowserId: { type: "string", ...internal, returned: false },
            stepUpFailures: { type: "number", ...internal, returned: false },
            currentOrganizationId: { type: "string", ...internal },
          }
        : {
            assurance: { type: "string", ...internal },
            absoluteExpiresAt: { type: "date", ...internal },
            createdVia: { type: "string", ...internal },
            accessSub: { type: "string", ...internal, returned: false },
            enrolmentOpenUntil: { type: "date", ...internal },
            stepUpFailures: { type: "number", ...internal, returned: false },
          },
    },
    account: {
      accountLinking: developer
        ? {
            enabled: true,
            disableImplicitLinking: true,
            allowDifferentEmails: false,
            // Unlinking Google never strands a person: the emailed code always signs them in
            // (§5.2), so the library's "last account" rule (which counts only account rows) is off.
            allowUnlinkingAll: true,
          }
        : { enabled: false },
      storeStateStrategy: "database",
      skipStateCookieCheck: false,
      // A Google sign-in rewrites no account row: Fin keeps no provider token (§4.2), and an
      // update that names `provider_id` would need an audit event on every sign-in (§13.8).
      updateAccountOnSignIn: false,
    },
    verification: { disableCleanup: true },
    emailAndPassword: { enabled: false },
    advanced: {
      cookiePrefix: settings.cookiePrefix,
      useSecureCookies: false,
      // `sameSite` is left to the library's Lax default ([SA-43]: never set here); only the
      // session cookie is Strict.
      defaultCookieAttributes: { secure: true, httpOnly: true, path: "/" },
      cookies: { session_token: { attributes: { sameSite: "strict" } } },
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"], ipv6Subnet: 48 },
      database: {
        generateId: ({ model }: { model: string }) =>
          newId(idPrefixFor(settings.realm, model), rt.clock),
      },
    },
    rateLimit: {
      enabled: true,
      window: 10,
      max: 100,
      customStorage: {
        consume: async (key: string, rule: { window: number; max: number }) => {
          const result = await rt.limits.consumeWindows(
            unitOf(rt),
            "default",
            [{ ms: rule.window * 1000, max: rule.max }],
            rt.hasher.bucket("limit", key),
          );
          return { allowed: result.allowed, retryAfter: result.allowed ? null : result.retryAfter };
        },
      },
      customRules: Object.fromEntries(reachable.map((r) => [r.path, { window: 10, max: 100 }])),
    },
    onAPIError: { throw: true, errorURL: `${settings.publicOrigin}/sign-in` },
    logger: {
      level: "warn",
      log: (level: string) => {
        rt.lines.write("auth.library_log", level === "error" ? "error" : "warn", {
          realm: settings.realm,
          level,
        });
      },
    },
    disabledPaths: rt.policy.disabledPaths(),
    hooks: { before, after },
    databaseHooks: databaseHooks(rt) as BetterAuthOptions["databaseHooks"],
    plugins: [
      emailOTP({
        otpLength: 8,
        expiresIn: developer ? 900 : 600,
        // 3 tries in the asking browser and 3 shared elsewhere, counted by Fin (§5.2); the
        // library's own count is the sum, so neither class can use up the other's.
        allowedAttempts: developer ? 6 : 3,
        storeOTP: "hashed",
        disableSignUp: !developer,
        sendVerificationOnSignUp: false,
        ...(developer ? { overrideDefaultEmailVerification: true } : {}),
        sendVerificationOTP,
      }),
      passkey({
        rpID: settings.rpId,
        rpName: settings.rpName,
        origin: settings.publicOrigin,
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      }),
      twoFactor({
        issuer: settings.totpIssuer,
        allowPasswordless: true,
        skipVerificationOnEnable: false,
        totpOptions: { digits: 6, period: 30 },
        ...(developer
          ? {
              backupCodeOptions: {
                amount: BACKUP_CODE_COUNT,
                length: BACKUP_CODE_LENGTH,
                storeBackupCodes: "encrypted" as const,
                // The library's draw, with a letter and a digit in every code (backup-codes.ts).
                customBackupCodesGenerate: generateBackupCodes,
              },
            }
          : {}),
        accountLockout: { enabled: true, maxFailedAttempts: 10, durationSeconds: 3600 },
      }),
      // Google (stretch 5, §5.8): only when the realm's own OAuth client is configured (CR-12).
      ...(google === null ? [] : [finGooglePlugin(google.provider)]),
    ],
  } as BetterAuthOptions;
}

function finishLine(rt: RealmRuntime, state: RequestState, status: number): void {
  const line: Record<string, LineValue> = { ...state.line, status };
  if (line.outcome === undefined)
    line.outcome = status < 400 ? "ok" : status >= 500 ? "error" : "refused";
  const fields = safeLineFields(line);
  if (state.context.annotate !== undefined) state.context.annotate(fields);
  else rt.lines.write("request", status >= 500 ? "error" : "info", fields);
}

function emptyNotFound(): Response {
  return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
}

/**
 * Whether a GET to a library path came from a page on another site or a sibling host (§2.3,
 * [SA-44]). The origin gate skips GETs, yet each library GET counts the library's per-address
 * limit, and some write a challenge or refresh the session, so a page elsewhere could spend the
 * victim's allowance from the victim's own browser. `Sec-Fetch-Site`, when the browser sends it,
 * must be `same-origin` (the app's own page) or `none` (opened directly); under the split host
 * the API is `same-site` to its page. A provider's callback is cross-site by design.
 */
function crossSiteGet(request: Request, rule: EndpointRule, settings: RealmSettings): boolean {
  if (request.method !== "GET" || rule.path === "/callback/:id") return false;
  const site = request.headers.get("sec-fetch-site");
  if (site === null || site === "same-origin" || site === "none") return false;
  return !(site === "same-site" && settings.apiOrigin !== null);
}

export function createRealm(deps: RealmDeps): Realm {
  const { settings } = deps;
  for (const origin of expectedTrustedOrigins(settings)) {
    if (!/^https?:\/\/[^/]+$/.test(origin))
      throw new Error("identity: a trusted origin is not an origin");
  }
  const policy = createEndpointPolicy(settings.realm, settings.features);
  const rt: RealmRuntime = {
    settings,
    policy,
    db: deps.db,
    clock: deps.clock,
    lines: deps.lines,
    audit: deps.audit ?? createRecordAudit({ clock: deps.clock, lines: deps.lines }),
    email: deps.email ?? createEmailEnqueue({ clock: deps.clock, lines: deps.lines }),
    limits: deps.limits ?? createLimitStore({ clock: deps.clock, lines: deps.lines }),
    hasher: new KeyedHasher(settings.limitKeys),
    killSwitch: deps.killSwitch ?? readKillSwitch,
    actions: stepUpCatalogue(deps.actions ?? []),
    requests: new AsyncLocalStorage<RequestState>(),
    docsOrigin: deps.docsOrigin,
  };
  // The library signs the state cookie with the newest secret, and reads it back with that one.
  const signing = settings.secrets[0];
  if (signing === undefined) throw new Error("identity: a realm without a secret");
  const google =
    settings.google === null
      ? null
      : createGoogleSignIn({
          settings: settings.google,
          clock: deps.clock,
          lines: deps.lines,
          realm: settings.realm,
          stateCookie: `${settings.cookiePrefix}.state`,
          stateSecret: signing.value,
          flow: () => requestState(rt).google,
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
  const auth = betterAuth(buildAuthOptions(rt, deps.db, google));

  /**
   * Google's callback does its outbound calls (the code exchange, the provider's keys) before the
   * request's unit of work opens, so no pooled client is held across them (ARCHITECTURE principle
   * 14). In a short unit of its own it counts the network's exchange allowance (§5.6) and then
   * claims the OAuth state, so one state buys at most one exchange. Answers the problem the realm
   * sends instead of the library's answer (the allowance is used up), or null.
   */
  async function prefetchGoogle(request: Request, state: RequestState): Promise<Response | null> {
    if (google === null) return null;
    const claim = (oauthState: string): Promise<StateClaim> =>
      rt.db.unit(
        async (tx) => {
          const network = rt.hasher.bucket("network", state.network);
          const allowed = await rt.limits.consume(tx, "google_exchange", network);
          if (!allowed.allowed) return { kind: "limited", retryAfter: allowed.retryAfter };
          return claimState(
            tx,
            oauthState,
            rt.clock.now(),
            state.context.requestId,
            settings.realm === "developer" ? "identity.verification" : "staff.verification",
          );
        },
        { requestId: state.context.requestId },
      );
    const refused = await rt.requests.run(state, () => google.prefetch(request, claim));
    if (refused === null) return null;
    return problem(
      state,
      new AuthRefusal("rate_limited", "limits.google_exchange", {
        retry_after: refused.retryAfter,
      }),
    );
  }

  const problem = (state: RequestState, refusal: AuthRefusal): Response => {
    state.line.outcome = "refused";
    state.line.reason = refusal.lineReason;
    return problemResponse(
      rt.docsOrigin,
      refusal.code,
      state.context.requestId,
      refusal.extensions,
    );
  };

  async function run<T>(
    context: RequestContext,
    fn: (tx: UnitTx, state: RequestState) => Promise<T>,
  ): Promise<T> {
    const bound = rt.requests.getStore();
    const state = bound ?? newRequestState(settings.realm, context);
    // A refusal commits what led to it (a counted try, a created intent, a failure event) and is
    // then thrown to the route; only a refusal marked `rollback` undoes the unit.
    let refusal: AuthRefusal | null = null;
    const result = await rt.db.unit(
      (tx) =>
        rt.requests.run(state, async () => {
          try {
            return await fn(tx, state);
          } catch (error) {
            if (error instanceof AuthRefusal && !error.rollback) {
              refusal = error;
              return undefined as T;
            }
            throw error;
          }
        }),
      { requestId: context.requestId },
    );
    if (refusal !== null) throw refusal;
    return result;
  }

  async function handler(request: Request, context: RequestContext): Promise<Response> {
    const state = newRequestState(settings.realm, context);
    const path = authPathOf(request.url, BASE_PATH);
    const rule = path === null ? null : policy.match(path, request.method);
    if (rule === null || rule.class === "blocked") {
      deps.lines.write("auth.endpoint_blocked", "warn", {
        realm: settings.realm,
        class: rule === null ? "unlisted" : "blocked",
      });
      state.line.reason = "policy.blocked";
      state.line.outcome = "refused";
      finishLine(rt, state, 404);
      return emptyNotFound();
    }
    state.rule = rule;
    state.line.authPath = rule.path;
    if (crossSiteGet(request, rule, settings)) {
      // Refused before any unit of work or limit, as the origin gate refuses an unsafe method.
      deps.lines.write("csrf.refused", "warn", {
        reason: "fetch_site",
        route: `${BASE_PATH}${rule.path}`,
      });
      state.line.outcome = "refused";
      state.line.reason = "origin_gate.fetch_site";
      const refused = problemResponse(rt.docsOrigin, "invalid_origin", context.requestId, {
        reason: "fetch_site",
      });
      finishLine(rt, state, refused.status);
      return refused;
    }
    if (
      google !== null &&
      request.method === "POST" &&
      (rule.path === "/sign-in/social" || rule.path === "/link-social")
    ) {
      // §2.3's redirect rule answers `400 invalid` before the library's own origin check.
      const fields =
        settings.realm === "developer"
          ? await googleRequestRefusal(request.clone(), rule.path, settings.publicOrigin)
          : await staffGoogleRequestRefusal(request.clone(), settings.publicOrigin);
      if (fields !== null) {
        state.line.outcome = "refused";
        state.line.reason = "body.google";
        const refused = problemResponse(rt.docsOrigin, "invalid", context.requestId, { fields });
        finishLine(rt, state, refused.status);
        return refused;
      }
    }
    let response: Response;
    try {
      // Only Google's own callback path prefetches, never the pattern itself (§4.1).
      const early =
        path === GOOGLE_CALLBACK && request.method === "GET"
          ? await prefetchGoogle(request, state)
          : null;
      response = early ?? (await libraryAnswer(request, state, rule));
    } catch (error) {
      response = failureResponse(rt, state, error);
    }
    finishLine(rt, state, response.status);
    return response;
  }

  /** The library's answer to an allowed request, in the request's unit of work (§3.5). */
  async function libraryAnswer(
    request: Request,
    state: RequestState,
    rule: EndpointRule,
  ): Promise<Response> {
    const answer = await rt.db.unit(
      (tx) =>
        rt.requests.run(state, async () => {
          try {
            const res = await auth.handler(request);
            // The whole answer is read before the unit commits; nothing is sent until then.
            return {
              status: res.status,
              headers: new Headers(res.headers),
              body: await res.arrayBuffer(),
            };
          } catch (error) {
            if (error instanceof AuthRefusal && !error.rollback) {
              const refused = problem(state, error);
              return {
                status: refused.status,
                headers: refused.headers,
                body: await refused.arrayBuffer(),
              };
            }
            if (error instanceof LimitStoreError || error instanceof AuthRefusal)
              tx.poison("refused");
            throw error;
          }
        }),
      { requestId: state.context.requestId },
    );
    if (!answer.headers.has("cache-control")) answer.headers.set("cache-control", "no-store");
    if (google !== null && rule.path === "/callback/:id") {
      googleCallbackLocation(answer.headers, state.google);
    }
    return new Response(answer.body.byteLength === 0 ? null : answer.body, {
      status: answer.status,
      headers: answer.headers,
    });
  }

  async function sessionOf(
    request: Request,
    context: RequestContext,
  ): Promise<RealmSession | null> {
    return run(context, async () => {
      const result = (await auth.api.getSession({
        headers: request.headers,
        returnHeaders: true,
      })) as {
        headers: Headers | null;
        response: { session: RealmSession["session"]; user: RealmSession["user"] } | null;
      };
      if (result.response === null) return null;
      const setCookies = result.headers?.getSetCookie() ?? [];
      return { session: result.response.session, user: result.response.user, setCookies };
    });
  }

  return {
    settings,
    policy,
    api: auth.api as unknown as AuthApi,
    auth,
    runtime: rt,
    handler,
    sessionOf,
    run,
  };
}

/** Maps a failure outside the unit to its answer; nothing the unit wrote has committed. */
function failureResponse(rt: RealmRuntime, state: RequestState, error: unknown): Response {
  const requestId = state.context.requestId;
  if (error instanceof AuthRefusal) {
    state.line.outcome = "refused";
    state.line.reason = error.lineReason;
    return problemResponse(rt.docsOrigin, error.code, requestId, error.extensions);
  }
  const cause = error instanceof UnitRolledBackError ? error.cause : error;
  if (error instanceof LimitStoreError || cause instanceof LimitStoreError) {
    state.line.outcome = "error";
    state.line.reason = "limits.store_failed";
    return problemResponse(rt.docsOrigin, "unavailable", requestId, { retry_after: 5 });
  }
  if (error instanceof AuditGuardError) {
    state.line.outcome = "error";
    state.line.reason = "database.audit_guard";
    return problemResponse(rt.docsOrigin, "internal", requestId);
  }
  const errorId = newId("req", rt.clock);
  state.line.outcome = "error";
  state.line.reason =
    error instanceof UnitRolledBackError ? `unit.${error.reason.split(":")[0]}` : "unexpected";
  rt.lines.write("auth.unhandled_error", "error", {
    realm: rt.settings.realm,
    authPath: typeof state.line.authPath === "string" ? state.line.authPath : null,
    errorId,
  });
  return problemResponse(rt.docsOrigin, "internal", requestId, { error_id: errorId });
}
