// Google sign-in for the staff realm (spec 02 §5.8, §6.4, §10.5; [SA-15]): the company Workspace's
// internal client, off until its own switch and client are configured (settings.ts). The flow is
// the developer realm's (provider.ts, state.ts: PKCE, the nonce, the exact redirect URI, the code
// exchanged and the ID token verified before the request's unit of work, one exchange per state),
// with the staff realm's rules on top:
//
//   - Google is at most a first factor. A Google sign-in makes the same `aal1` staff session an
//     emailed code makes (10 minutes, bound to the Access identity's `sub`): a member with a factor
//     is at the factor step, a pending member at enrolment, which still needs the enrolment code.
//     It never raises a session, never skips enrolment, and never reaches a permission.
//   - Only a member of staff: the verified address must be an `active` or `pending` member's, and
//     equal to the address Cloudflare Access let in on this very request (the API half checked the
//     Access token before the realm ran, and checks it again on every later request). The ID
//     token's `hd` must be the company's Workspace domain. No member is ever made from Google.
//   - No sign-in method row is kept. `staff.account` stays empty (its guard refuses every write,
//     §13.8), so the library's account linking is never used: once the ID token and the member
//     pass, the callback's before-hook checks the state as the library's callback would
//     (`parseState`: the signed cookie, the stored row, its expiry; the row is consumed), makes
//     the session through the library's adapter (so Fin's session hook sets its fields), sets the
//     session cookie and sends the browser on, with `staff.second_factor_required` in the same
//     unit of work. A refusal goes back to the sign-in page with `?error=`, its line, and, for a
//     listed member, `staff.sign_in_failed`.
//
// Anything the before-hook leaves to the library (no verified token: the person cancelled, a
// round trip the client's own request caused to be refused, a failure on Fin's side or Google's)
// ends in the library's own refusal, which the after-hook lines as the developer realm's does:
// `auth.google_failed` only for what Fin or the provider did, and `auth.google_refused` with its
// reason for anything a client can cause (flow.ts decides which is which).
import { setSessionCookie } from "better-auth/cookies";
import { parseState } from "better-auth/oauth2";
import { AuthRefusal } from "../errors.ts";
import { FACTOR_STEP_LIFETIME_MS } from "../gate.ts";
import type { HookContext, LibrarySession, LibraryUser } from "../hooks/context.ts";
import { bodyOf } from "../hooks/context.ts";
import { audit } from "../hooks/shared.ts";
import { HOUR } from "../ports/clock.ts";
import type { UnitTx } from "../ports/db.ts";
import type { RequestState } from "../request.ts";
import type { RealmRuntime } from "../runtime.ts";
import { factorFacts, personByEmail } from "../store.ts";
import { refusalPageError } from "./flow.ts";
import { redirectError, refusedCallbackTarget } from "./hooks.ts";
import { type GoogleRedirectField, googleReturnUrl } from "./redirect.ts";

/** Fin Admin's pages a staff Google round trip may come back to: only the sign-in page. */
export const STAFF_GOOGLE_PAGES: readonly string[] = ["/sign-in"];

/** The `?error=` a refused staff round trip carries when the Google account may not sign in. */
export const STAFF_ACCOUNT_REFUSED = "account_refused";

const ABSOLUTE_MS = 12 * HOUR;
const FIELDS: readonly GoogleRedirectField[] = ["callbackURL", "errorCallbackURL"];

type Data = Record<string, unknown>;

/** Why a staff Google account was refused (the `auth.google_refused` line's `reason`). */
type StaffRefusal = "hosted_domain" | "not_listed" | "removed" | "access_mismatch";

/**
 * The fields of a staff `/sign-in/social` body that §2.3's rule refuses, checked by the realm
 * before the library runs; null when the body passes. No `newUserCallbackURL`: no member is made.
 */
export async function staffGoogleRequestRefusal(
  request: Request,
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
  if (fields.callbackURL === undefined) refused.push("callbackURL");
  for (const name of FIELDS) {
    if (fields[name] === undefined) continue;
    if (googleReturnUrl(fields[name], publicOrigin, STAFF_GOOGLE_PAGES) === null) {
      refused.push(name);
    }
  }
  if (fields.newUserCallbackURL !== undefined) refused.push("newUserCallbackURL");
  return refused.length === 0 ? null : refused;
}

/** `/sign-in/social` in the staff realm, after the gate: Google only, the staff pages only. */
export function staffGoogleBefore(rt: RealmRuntime, ctx: HookContext, state: RequestState): void {
  if (state.context.access === null || state.context.access === undefined) {
    throw new AuthRefusal("access_required", "access.missing");
  }
  const body = bodyOf(ctx);
  const refused: string[] = [];
  if (body.provider !== "google") refused.push("provider");
  if (body.callbackURL === undefined) refused.push("callbackURL");
  if (body.newUserCallbackURL !== undefined) refused.push("newUserCallbackURL");
  const origin = rt.settings.publicOrigin;
  for (const field of FIELDS) {
    if (body[field] === undefined) continue;
    const url = googleReturnUrl(body[field], origin, STAFF_GOOGLE_PAGES);
    if (url === null) refused.push(field);
    else body[field] = url;
  }
  if (refused.length > 0) throw new AuthRefusal("invalid", "body.google", { fields: refused });
  // A failure comes back to the sign-in page; the library appends `?error=<code>`.
  body.errorCallbackURL ??= `${origin}${STAFF_GOOGLE_PAGES[0]}`;
}

/** The library's adapter calls the callback's before-hook makes (pinned by the realm's tests). */
interface SessionAdapter {
  createSession(userId: string): Promise<LibrarySession | null>;
  findUserById(userId: string): Promise<LibraryUser | null>;
}

/**
 * The staff callback, before the library: a state another callback already exchanged is refused
 * (as in the developer realm); a verified ID token is checked against the Workspace domain, the
 * staff table and the Access identity, and then the session is made here (see the file's head).
 * Returns undefined to let the library refuse what Fin has no verified token for.
 */
export async function staffGoogleCallbackBefore(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
  tx: UnitTx,
): Promise<unknown> {
  const redirect = (url: string): unknown =>
    (ctx as unknown as { redirect(url: string): unknown }).redirect(url);
  const spent = state.google.spentState;
  if (spent !== null) {
    rt.lines.write("auth.google_refused", "warn", { realm: "staff", reason: "state_used" });
    state.line.outcome = "refused";
    state.line.reason = "google.state_used";
    throw redirect(refusedCallbackTarget(rt, spent.errorURL, "state_mismatch"));
  }
  const prefetched = state.google.prefetched;
  const query = ctx.query ?? {};
  if (
    prefetched === null ||
    prefetched.kind !== "token" ||
    // The library refuses a callback for its `error` only when that is not empty; with an empty
    // one it goes on to the code as if there were none, so the staff checks below decide it.
    (query.error !== undefined && query.error !== "") ||
    query.code !== prefetched.code
  ) {
    return undefined;
  }
  const access = state.context.access;
  if (access === null || access === undefined) {
    throw new AuthRefusal("access_required", "access.missing");
  }
  // The library's own state check, as its callback makes it; a mismatch or an expired state is
  // sent back refused by the library here. The stored row is consumed and the cookie expired.
  const parsed = (await parseState(ctx as never)) as {
    callbackURL: string;
    codeVerifier: string;
    errorURL?: string;
    idTokenNonce?: string;
  };
  if (parsed.codeVerifier !== prefetched.codeVerifier || parsed.idTokenNonce !== prefetched.nonce) {
    // The prefetch read the same row under its lock; anything else is not this sign-in's token.
    rt.lines.write("auth.google_refused", "warn", { realm: "staff", reason: "state_mismatch" });
    state.line.outcome = "refused";
    state.line.reason = "google.state_mismatch";
    throw redirect(refusedCallbackTarget(rt, parsed.errorURL ?? null, "state_mismatch"));
  }
  const claims = prefetched.claims;
  const member = await personByEmail(tx, "staff", claims.email);
  const refusal: StaffRefusal | null =
    claims.hostedDomain === undefined || claims.hostedDomain !== rt.settings.google?.hostedDomain
      ? "hosted_domain"
      : member === null
        ? "not_listed"
        : member.status === "removed"
          ? "removed"
          : claims.email !== access.email.trim().toLowerCase()
            ? "access_mismatch"
            : null;
  if (refusal !== null || member === null) {
    const reason: StaffRefusal = refusal ?? "not_listed";
    rt.lines.write("auth.google_refused", "warn", { realm: "staff", reason });
    if (reason === "not_listed") rt.lines.write("staff.not_listed", "warn", { reason: "google" });
    if (member !== null && reason !== "not_listed") {
      if (reason === "access_mismatch") {
        rt.lines.write("staff.access_mismatch", "warn", { staffId: member.id });
      }
      await audit(rt, tx, state, {
        event: "staff.sign_in_failed",
        personId: member.id,
        target: member.id,
        metadata: { method: "google", reason },
      });
    }
    state.line.outcome = "refused";
    state.line.reason = `google.${reason}`;
    throw redirect(refusedCallbackTarget(rt, parsed.errorURL ?? null, STAFF_ACCOUNT_REFUSED));
  }
  const adapter = ctx.context.internalAdapter as unknown as SessionAdapter;
  const session = await adapter.createSession(member.id);
  const user = await adapter.findUserById(member.id);
  if (session === null || user === null) {
    throw new Error("identity: the staff Google session was not made");
  }
  await audit(rt, tx, state, {
    event: "staff.second_factor_required",
    personId: member.id,
    target: session.id,
    refs: [member.id],
    metadata: {},
  });
  await setSessionCookie(ctx as never, { session, user } as never);
  const factors = await factorFacts(tx, "staff", member.id);
  state.line.staffId = member.id;
  state.line.assurance = "aal1";
  // A member with no factor yet is pending (enrolment); one with a factor is at the factor step.
  state.line.gate = factors.count === 0 ? "pending" : "factor_step";
  throw redirect(parsed.callbackURL);
}

/**
 * The session a staff Google sign-in makes (§6.1, §6.4, §11.1): `aal1`, Google's, bound to the
 * Access identity of the request, 10 minutes until the factor step or enrolment is done.
 */
export function staffGoogleSessionFields(rt: RealmRuntime, state: RequestState): Data {
  const access = state.context.access;
  if (access === null || access === undefined) {
    throw new Error("staff session without an Access identity");
  }
  const now = rt.clock.now();
  return {
    assurance: "aal1",
    createdVia: "google",
    accessSub: access.sub,
    enrolmentOpenUntil: null,
    absoluteExpiresAt: new Date(now.getTime() + ABSOLUTE_MS),
    expiresAt: new Date(now.getTime() + FACTOR_STEP_LIFETIME_MS),
  };
}

/**
 * The staff callback, after the library: only a refusal can reach it, since Fin makes every staff
 * Google session in the before-hook. A session the library made itself is refused and undone.
 */
export async function staffGoogleCallbackAfter(
  rt: RealmRuntime,
  ctx: HookContext,
  state: RequestState,
): Promise<void> {
  const error = redirectError(ctx);
  if (error === null) {
    const made = ctx.context.newSession;
    if (made !== null && made !== undefined) {
      throw new AuthRefusal("internal", "google.staff_library_session", {}, { rollback: true });
    }
    return;
  }
  // As in the developer realm. Where the library refused because Fin's provider answered nothing,
  // the prefetch says why (flow.ts): a failure on Fin's side or the provider's was lined when it
  // was prefetched, and the page says `google_failed`; anything the client's round trip caused is
  // a refusal, lined here with its own reason. Any other `error` is the library's refusal (the
  // person cancelled, a state that does not match, …).
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
    reason = error;
  }
  rt.lines.write("auth.google_refused", "warn", { realm: "staff", reason });
  state.line.outcome = "refused";
  state.line.reason = `google.${reason}`;
}
