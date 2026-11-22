// Google sign-in's parts of the realm's hooks (spec 02 §3.5, §5.8, §6.1, §7.6, §16.2, §17.2):
//
//   - before `/sign-in/social` and `/link-social`: Google only, and the redirect targets of §2.3;
//     a link also puts its validated step-up intent in the OAuth state's server context;
//   - before `/unlink-account`: only the person's own Google account may be unlinked;
//   - before `/callback/:id`: a callback whose state another callback already exchanged is sent
//     back refused before the library touches the state, and a link's intent is checked before
//     the library links anything;
//   - `databaseHooks`: a Google session is `aal1` with `createdVia: google`, and proves the
//     mailbox only when Google verified the account's own address this time; a person is made from
//     a Google profile only with a verified address and while sign-ups are open; a Google account
//     row keeps no provider token; the library's re-link update is dropped;
//   - after the callback: `user.created`, `account.linked`, then `session.created` or
//     `sign_in.second_factor_required`, the known-browser notice, or for a link `account.linked`
//     with the intent consumed and `sign-in-methods-changed`; after `/unlink-account`,
//     `account.unlinked` with its intent and the notice. Every event is written in the request's
//     unit of work, so the guard on `identity.account` (§13.8) sees it.
import { addOAuthServerContext, getOAuthState } from "better-auth/api";
import { AuthRefusal } from "../errors.ts";
import { FACTOR_STEP_LIFETIME_MS, personGate } from "../gate.ts";
import type { HookContext } from "../hooks/context.ts";
import { bodyOf } from "../hooks/context.ts";
import { audit, device, notify, nowIso } from "../hooks/shared.ts";
import { checkName } from "../names.ts";
import { DAY } from "../ports/clock.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import type { RealmRuntime } from "../runtime.ts";
import { consumeIntent, readIntent } from "../step-up/intents.ts";
import { personById } from "../store.ts";
import { type GoogleFlow, refusalPageError } from "./flow.ts";
import { GOOGLE_RETURN_PAGES, type GoogleRedirectField, googleReturnUrl } from "./redirect.ts";
import { LINK_INTENT_KEY } from "./state.ts";

export const GOOGLE_PATHS = new Set(["/sign-in/social", "/link-social", "/unlink-account"]);
export const CALLBACK_PATH = "/callback/:id";
const ABSOLUTE_MS = 7 * DAY;
const IDLE_MS = DAY;

/** The callback's paths as the library's hooks may name them. */
export function isCallbackPath(path: string): boolean {
  return path === CALLBACK_PATH || path === "/callback/google";
}

function invalid(fields: string[]): AuthRefusal {
  return new AuthRefusal("invalid", "body.google", { fields });
}

/** Checks and rewrites the redirect targets a Google route was sent (§2.3). */
function redirectTargets(
  rt: RealmRuntime,
  body: Record<string, unknown>,
  fields: readonly GoogleRedirectField[],
  pages: readonly string[],
): void {
  const origin = rt.settings.publicOrigin;
  const refused: string[] = [];
  for (const field of fields) {
    if (body[field] === undefined) continue;
    const url = googleReturnUrl(body[field], origin, pages);
    if (url === null) refused.push(field);
    else body[field] = url;
  }
  if (refused.length > 0) throw invalid(refused);
  if (body.callbackURL === undefined) throw invalid(["callbackURL"]);
  // A failure comes back to the page the flow began on; the library appends `?error=<code>`.
  body.errorCallbackURL ??= `${origin}${pages[0] ?? "/sign-in"}`;
}

/**
 * The fields of a `/sign-in/social` or `/link-social` body that §2.3's rule refuses, checked by
 * the realm before the library runs (the library's own origin check would otherwise answer first,
 * with its 403); null when the body passes. The before-hook checks the same again.
 */
export async function googleRequestRefusal(
  request: Request,
  path: string,
  publicOrigin: string,
): Promise<string[] | null> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return null; // not JSON: the origin gate and the library refuse it
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const fields = body as Record<string, unknown>;
  const refused: string[] = [];
  if (fields.provider !== "google") refused.push("provider");
  const link = path === "/link-social";
  const pages = link ? GOOGLE_RETURN_PAGES.link : GOOGLE_RETURN_PAGES.signIn;
  const names: readonly GoogleRedirectField[] = link
    ? ["callbackURL", "errorCallbackURL"]
    : ["callbackURL", "errorCallbackURL", "newUserCallbackURL"];
  for (const name of names) {
    if (fields[name] === undefined) {
      if (name === "callbackURL") refused.push(name);
      continue;
    }
    if (googleReturnUrl(fields[name], publicOrigin, pages) === null) refused.push(name);
  }
  if (link && fields.newUserCallbackURL !== undefined) refused.push("newUserCallbackURL");
  return refused.length === 0 ? null : refused;
}

/** `/sign-in/social`, `/link-social` and `/unlink-account`, after the gate and the step-up rule. */
export async function googleBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<void> {
  const body = bodyOf(ctx);
  if (ctx.path === "/unlink-account") {
    const prior = state.prior;
    if (prior === null) throw new AuthRefusal("unauthenticated", "gate.signed_out");
    const accountId = typeof body.accountId === "string" ? body.accountId : "";
    const owned = await tx.query<{ id: string }>(
      `SELECT id FROM identity.account WHERE id = $1 AND user_id = $2 AND provider_id = 'google'`,
      [accountId, prior.person.id],
    );
    // Only the person's own Google account: never a password, never anyone else's.
    if (owned.rowCount === 0) throw new AuthRefusal("not_found", "google.unlink_not_found");
    state.google.unlinking = { id: accountId, userId: prior.person.id };
    return;
  }
  if (body.provider !== "google") throw invalid(["provider"]);
  if (ctx.path === "/sign-in/social") {
    redirectTargets(
      rt,
      body,
      ["callbackURL", "errorCallbackURL", "newUserCallbackURL"],
      GOOGLE_RETURN_PAGES.signIn,
    );
    return;
  }
  // `/link-social`: the step-up rule has validated the request's intent; the callback consumes it
  // in the transaction that links the account, so it rides the state's server context (which the
  // client cannot set, unlike `additionalData`).
  redirectTargets(rt, body, ["callbackURL", "errorCallbackURL"], GOOGLE_RETURN_PAGES.link);
  if (state.intent === null) throw new AuthRefusal("forbidden", "step_up.unknown_action");
  await addOAuthServerContext({ [LINK_INTENT_KEY]: state.intent.id });
}

/**
 * Where a refused callback goes when the realm answers it itself: the state's error page when Fin's
 * redirect rule allowed it (an absolute URL on the public origin), else the sign-in page.
 */
function refusedCallbackTarget(rt: RealmRuntime, errorURL: string | null, error: string): string {
  const origin = rt.settings.publicOrigin;
  let target = new URL(`${origin}${GOOGLE_RETURN_PAGES.signIn[0]}`);
  if (errorURL?.startsWith(`${origin}/`)) {
    try {
      const parsed = new URL(errorURL);
      if (parsed.origin === origin) target = parsed;
    } catch {
      // The sign-in page, then.
    }
  }
  target.searchParams.set("error", error);
  return target.href;
}

/**
 * The callback, before the library: one whose state another callback already exchanged is sent
 * back with `error=state_mismatch` before the library could consume the state the other one holds
 * (one state buys one exchange, state.ts); a link whose intent can no longer be used is sent back
 * to Account security with `error=step_up_invalid` before anything is linked.
 */
export async function googleCallbackBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const redirect = (url: string): unknown =>
    (ctx as unknown as { redirect(url: string): unknown }).redirect(url);
  const spent = state.google.spentState;
  if (spent !== null) {
    rt.lines.write("auth.google_refused", "warn", { realm: "developer", reason: "state_used" });
    state.line.outcome = "refused";
    state.line.reason = "google.state_used";
    throw redirect(refusedCallbackTarget(rt, spent.errorURL, "state_mismatch"));
  }
  const prefetched = state.google.prefetched;
  const intentId = prefetched?.linkIntentId ?? null;
  if (intentId === null) return undefined;
  const intent = await readIntent(tx, intentId);
  if (
    intent !== null &&
    intent.realm === "developer" &&
    intent.action === "account.google_link" &&
    intent.consumedAt === null &&
    intent.provedAt !== null &&
    intent.live
  ) {
    return undefined;
  }
  rt.lines.write("step_up.refused", "warn", {
    realm: "developer",
    action: "account.google_link",
    reason: intent === null ? "other_session" : intent.consumedAt !== null ? "used" : "expired",
  });
  state.line.reason = "google.step_up_invalid";
  throw redirect(`${rt.settings.publicOrigin}${GOOGLE_RETURN_PAGES.link[0]}?error=step_up_invalid`);
}

type Data = Record<string, unknown>;

/** The session the callback makes (§6.1, §6.3): `aal1`, Google's, the mailbox proved or not. */
export async function googleSessionFields(
  rt: RealmRuntime,
  state: RequestState,
  tx: UnitTx,
  userId: string,
): Promise<Data> {
  const claims = state.google.claims;
  if (claims === null) throw new Error("identity: a Google session without a verified token");
  const now = rt.clock.now();
  const person = await personById(tx, "developer", userId);
  const facts = await personGate(tx, userId);
  // Google proves the mailbox only when it verified the account's own address this time (§5.8).
  const proved = person !== null && person.email === claims.email;
  return {
    assurance: "aal1",
    createdVia: "google",
    mailboxProvedAt: proved ? now : null,
    // A Google sign-in never rides a trusted browser: the factor step asks for the factor.
    trustedBrowserId: null,
    currentOrganizationId: null,
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_MS),
    expiresAt: new Date(
      now.getTime() + (facts.factorCount > 0 ? FACTOR_STEP_LIFETIME_MS : IDLE_MS),
    ),
  };
}

/** A person made from a Google profile (§5.1, §5.8, [SA-40]); anything else fails closed. */
export async function googleUserFields(
  rt: RealmRuntime,
  state: RequestState,
  tx: UnitTx,
  user: Data,
): Promise<Data> {
  const claims = state.google.claims;
  const email = String(user.email ?? "").toLowerCase();
  if (claims === null || email !== claims.email) {
    throw new Error("identity: a person may be made only from a verified Google address");
  }
  if ((await rt.killSwitch(tx, "signups")) === "on") {
    state.line.reason = "switch.signups";
    throw new Error("identity: sign-ups are paused");
  }
  // The sign-up velocity of [SA-40] counts every new account, whatever made it.
  for (const [bucket, subject] of [
    ["sign_up_network", rt.hasher.bucket("network", state.network)],
    ["sign_up_address", rt.hasher.bucket("email", email)],
  ] as const) {
    const allowed = await rt.limits.consume(tx, bucket, subject);
    if (!allowed.allowed) {
      state.line.reason = `limits.${bucket}`;
      throw new Error("identity: the sign-up limit refused a Google account");
    }
  }
  // The profile's name only when it passes the name rule (§8.6); else none, as a code sign-up.
  const name = claims.name === null ? null : checkName("personName", claims.name);
  state.google.creatingUser = true;
  return {
    ...user,
    email,
    emailVerified: true,
    name: name?.ok ? name.value : "",
    image: null,
  };
}

const TOKEN_FIELDS = [
  "accessToken",
  "refreshToken",
  "idToken",
  "accessTokenExpiresAt",
  "refreshTokenExpiresAt",
  "scope",
] as const;

/**
 * A Google account row: made only by the callback, holding no provider token (no Google token is
 * handed out, §4.2, so none is kept). Other providers' rows (passwords) pass untouched.
 */
export function googleAccountCreate(state: RequestState, path: string, account: Data): Data | null {
  if (account.providerId !== "google") return null;
  if (!isCallbackPath(path)) {
    throw new Error("identity: a Google account may be made only by the callback");
  }
  const sub = String(account.accountId ?? "");
  const userId = String(account.userId ?? "");
  if (sub === "" || userId === "") throw new Error("identity: a Google account without a key");
  state.google.creatingAccounts.push({ sub, userId });
  const stripped: Data = { ...account };
  for (const field of TOKEN_FIELDS) stripped[field] = null;
  return stripped;
}

/** The library's update of a Google row on a re-link carries only tokens: it is dropped. */
export function googleAccountUpdateDropped(update: Data): boolean {
  if (update.providerId === "google") return true;
  const keys = Object.keys(update).filter((k) => k !== "updatedAt");
  return keys.length > 0 && keys.every((k) => (TOKEN_FIELDS as readonly string[]).includes(k));
}

const REFUSALS = new Set([
  "access_denied",
  "account_not_linked",
  "signup_disabled",
  "unable_to_create_user",
  "email_does_not_match",
  "account_already_linked_to_different_user",
  "unable_to_link_account",
  "unable_to_get_user_info",
  "state_mismatch",
  "state_not_found",
  "invalid_code",
  "step_up_invalid",
]);

/** The `error` a callback's redirect carries, bounded for the line. */
function redirectError(ctx: HookContext): string | null {
  const returned = ctx.context.returned as { headers?: Headers } | undefined;
  const location = returned?.headers?.get?.("location") ?? null;
  if (location === null) return null;
  try {
    const error = new URL(location, "https://fin.invalid").searchParams.get("error");
    if (error === null) return null;
    return REFUSALS.has(error) ? error : "other";
  } catch {
    return "other";
  }
}

/**
 * The callback's answer, as the realm sends it: a refusal's `?error=` carries Fin's own code when
 * the after-hook chose a better one, and never the provider's `error_description`, whose text no
 * page shows and no Fin URL should carry.
 */
export function googleCallbackLocation(headers: Headers, flow: GoogleFlow): void {
  const location = headers.get("location");
  if (location === null) return;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return;
  }
  if (!url.searchParams.has("error")) return;
  if (flow.redirectError !== null) url.searchParams.set("error", flow.redirectError);
  url.searchParams.delete("error_description");
  headers.set("location", url.href);
}

async function accountRow(tx: UnitTx, sub: string, userId: string): Promise<string | null> {
  const row = await tx.query<{ id: string }>(
    `SELECT id FROM identity.account WHERE provider_id = 'google' AND account_id = $1 AND user_id = $2`,
    [sub, userId],
  );
  return row.rows[0]?.id ?? null;
}

/** The callback, after the library: the events of a sign-in, a sign-up or a link. */
export async function googleCallbackAfter(
  rt: RealmRuntime,
  ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  knownBrowserNotice: (
    person: { id: string; email: string },
    firstSignIn: boolean,
  ) => Promise<void>,
): Promise<void> {
  const error = redirectError(ctx);
  if (error !== null) {
    // On its way back to the page with `?error=`. Where the library refused because Fin's provider
    // answered nothing, the prefetch says why (flow.ts): a failure on Fin's side or the provider's
    // was lined when it was prefetched, and the page says `google_failed`; anything the client's
    // round trip caused is a refusal, lined here with its own reason. Any other `error` is the
    // library's refusal (the person cancelled, an account not linked, sign-ups paused, …).
    const prefetched = state.google.prefetched;
    const fromProvider = error === "invalid_code" || error === "unable_to_get_user_info";
    const outcome =
      fromProvider && prefetched !== null && prefetched.kind !== "token" ? prefetched : null;
    if (outcome?.kind === "failed") {
      state.google.redirectError = "google_failed";
      state.line.outcome = "error";
      state.line.reason = "google.failed";
      return;
    }
    let reason: string;
    if (outcome?.kind === "refused") {
      state.google.redirectError = refusalPageError(outcome.refusal);
      reason = outcome.refusal;
    } else {
      state.google.redirectError = null;
      const lineReason = typeof state.line.reason === "string" ? state.line.reason : "";
      reason =
        lineReason === "switch.signups"
          ? "signups_paused"
          : lineReason.startsWith("limits.sign_up")
            ? "sign_up_limited"
            : error;
    }
    rt.lines.write("auth.google_refused", "warn", { realm: "developer", reason });
    state.line.outcome = "refused";
    state.line.reason = `google.${reason}`;
    return;
  }
  const created = ctx.context.newSession;
  if (created !== null && created !== undefined) {
    await signedIn(rt, ctx, tx, state, created, knownBrowserNotice);
    return;
  }
  await linked(rt, tx, state);
}

async function signedIn(
  rt: RealmRuntime,
  _ctx: HookContext,
  tx: UnitTx,
  state: RequestState,
  created: { session: { id: string }; user: { id: string; email: string } },
  knownBrowserNotice: (
    person: { id: string; email: string },
    firstSignIn: boolean,
  ) => Promise<void>,
): Promise<void> {
  const sessionId = created.session.id;
  const userId = created.user.id;
  const isNew = state.google.creatingUser;
  state.line.userId = userId;
  state.line.assurance = "aal1";
  if (isNew) {
    state.createdUserId = userId;
    await audit(rt, tx, state, {
      event: "user.created",
      personId: userId,
      target: userId,
      refs: [sessionId],
      metadata: { method: "google", viaInvitation: false },
    });
  }
  for (const pending of state.google.creatingAccounts) {
    if (pending.userId !== userId) continue;
    const accountId = await accountRow(tx, pending.sub, userId);
    if (accountId === null) continue;
    await audit(rt, tx, state, {
      event: "account.linked",
      personId: userId,
      target: accountId,
      refs: [userId],
      metadata: { provider: "google" },
    });
  }
  const facts = await personGate(tx, userId);
  if (facts.factorCount > 0) {
    const factors = await tx.query<{ passkeys: number; verified: boolean | null }>(
      `SELECT (SELECT count(*)::integer FROM identity.passkey WHERE user_id = $1) AS passkeys,
              (SELECT verified FROM identity.two_factor WHERE user_id = $1) AS verified`,
      [userId],
    );
    const methods: string[] = [];
    if (Number(factors.rows[0]?.passkeys ?? 0) > 0) methods.push("passkey");
    if (factors.rows[0]?.verified === true) methods.push("authenticator", "backup_code");
    await audit(rt, tx, state, {
      event: "sign_in.second_factor_required",
      personId: userId,
      target: sessionId,
      refs: [userId],
      metadata: { methods },
    });
    state.line.gate = "factor_step";
    return;
  }
  await audit(rt, tx, state, {
    event: "session.created",
    personId: userId,
    target: sessionId,
    refs: [userId],
    metadata: { method: "google", assurance: "aal1", trustedBrowser: false },
  });
  state.line.gate = facts.privilegedAnywhere ? "hold" : "ok";
  await knownBrowserNotice(created.user, isNew);
}

/** A link from Account security (§5.8): the account, its event and its intent, one transaction. */
async function linked(rt: RealmRuntime, tx: UnitTx, state: RequestState): Promise<void> {
  const pending = state.google.creatingAccounts[0];
  if (pending === undefined) return; // a re-link of the same account: nothing changed
  const oauth = (await getOAuthState()) as { serverContext?: Record<string, unknown> } | null;
  const intentId = oauth?.serverContext?.[LINK_INTENT_KEY];
  const intent = typeof intentId === "string" ? await readIntent(tx, intentId) : null;
  const person = await personById(tx, "developer", pending.userId);
  const accountId = await accountRow(tx, pending.sub, pending.userId);
  if (
    intent === null ||
    person === null ||
    accountId === null ||
    intent.principalId !== person.id
  ) {
    throw new AuthRefusal(
      "step_up_invalid",
      "step_up.link",
      { reason: "other_session" },
      {
        rollback: true,
      },
    );
  }
  const method = await consumeIntent(
    tx,
    intent.id,
    {
      realm: "developer",
      sessionId: intent.sessionId,
      principalId: intent.principalId,
      organizationId: null,
      action: "account.google_link",
      digest: intent.digest,
    },
    state.context.requestId,
  );
  if (method === null) {
    rt.lines.write("step_up.refused", "warn", {
      realm: "developer",
      action: "account.google_link",
      reason: "used",
    });
    throw new AuthRefusal(
      "step_up_invalid",
      "step_up.used",
      { reason: "used" },
      { rollback: true },
    );
  }
  state.line.userId = person.id;
  state.line.stepUp = "intent";
  state.line.stepUpOutcome = "passed";
  await audit(rt, tx, state, {
    event: "account.linked",
    personId: person.id,
    target: accountId,
    refs: [person.id, intent.id],
    metadata: { provider: "google" },
    actor: {
      kind: "user",
      id: person.id,
      via: "console",
      stepUp: { kind: "intent", method, ref: intent.id },
    },
  });
  await notify(rt, tx, "identity/sign-in-methods-changed", person.email, {
    userId: person.id,
    kind: "google_linked",
    device: device(state),
    time: nowIso(rt),
  });
}

/** `/unlink-account`, after the library removed the row: its event, its intent, the notice. */
export async function googleUnlinked(
  rt: RealmRuntime,
  tx: UnitTx,
  state: RequestState,
  consume: () => Promise<{ id: string; method: "passkey" | "totp" | "backup_code" } | null>,
): Promise<void> {
  const unlinking = state.google.unlinking;
  const prior = state.prior;
  if (unlinking === null || prior === null) return;
  const intent = await consume();
  await audit(rt, tx, state, {
    event: "account.unlinked",
    personId: prior.person.id,
    target: unlinking.id,
    refs: [prior.person.id, ...(intent === null ? [] : [intent.id])],
    metadata: { provider: "google" },
    ...(intent === null
      ? {}
      : {
          actor: {
            kind: "user" as const,
            id: prior.person.id,
            via: "console" as const,
            stepUp: { kind: "intent" as const, method: intent.method, ref: intent.id },
          },
        }),
  });
  await notify(rt, tx, "identity/sign-in-methods-changed", prior.person.email, {
    userId: prior.person.id,
    kind: "google_unlinked",
    device: device(state),
    time: nowIso(rt),
  });
}
