// The endpoint allowlist per realm ([SA-09], spec 02 §4). Every path a realm's router mounts is
// listed exactly once, as `public`, `session`, `step_up_self`, `step_up_org` or `blocked`, with
// the gate states that may reach it and its Fin limit bucket. Matching is exact on the raw path
// after `/api/auth`, before the router and before any limit is counted. Anything unlisted or
// blocked answers 404 with an empty body. Moving a path out of `blocked` needs the owner's
// approval (AGENTS.md); T-SAT-01 fails when the installed router's set differs from this file.
// A GET counts no Fin budget and makes no intent (§2.3, [SA-44]: a sibling page can send one with
// the session cookie), so every GET's bucket is `default`, the library's flood limit, and the
// realm refuses a GET that another site sent before even that is counted.
import type { RealmName } from "./config.ts";
import type { LimitBucket } from "./limits.ts";

export type EndpointClass = "public" | "session" | "step_up_self" | "step_up_org" | "blocked";

/** The gate states (spec 02 §6.2, §6.4); `signed_out` is a request with no live session. */
export type GateState = "signed_out" | "factor_step" | "hold" | "ok" | "pending";

export type HttpMethod = "GET" | "POST";

export interface EndpointRule {
  readonly path: string;
  readonly methods: readonly HttpMethod[];
  readonly class: EndpointClass;
  /** The gate states that may reach the path; empty for blocked paths. */
  readonly reach: readonly GateState[];
  /** Fin's limit bucket (§5.6); `null` means never limited (removals, §6.7). */
  readonly limit: LimitBucket | null;
  /** Why a path is blocked, or a note on a reachable one. */
  readonly note: string;
}

const ANY: readonly GateState[] = ["signed_out", "factor_step", "hold", "ok", "pending"];

function rule(
  path: string,
  methods: readonly HttpMethod[],
  cls: Exclude<EndpointClass, "blocked">,
  reach: readonly GateState[],
  limit: LimitBucket | null,
  note: string,
): EndpointRule {
  return { path, methods, class: cls, reach, limit, note };
}

function blocked(path: string, methods: readonly HttpMethod[], note: string): EndpointRule {
  return { path, methods, class: "blocked", reach: [], limit: null, note };
}

/** Paths blocked in both realms, with the reason recorded beside each (§4.2). */
const BLOCKED_BOTH: readonly EndpointRule[] = [
  blocked("/ok", ["GET"], "a library health probe; the API half has its own"),
  blocked("/sign-up/email", ["POST"], "sign-up is Fin's own POST /api/sign-up (S2-05)"),
  blocked("/email-otp/verify-email", ["POST"], "sign-up is Fin's own route (S2-05)"),
  blocked("/email-otp/check-verification-otp", ["POST"], "a code oracle"),
  blocked("/send-verification-email", ["POST"], "link-based flow acting on a GET (C3 §2.2)"),
  blocked("/verify-email", ["GET"], "a token-acting GET ([SA-09])"),
  blocked("/request-password-reset", ["POST"], "link-based flow (C3 §2.2)"),
  blocked("/reset-password", ["POST"], "link-based flow (C3 §2.2)"),
  blocked("/reset-password/:token", ["GET"], "a token-acting GET ([SA-09])"),
  blocked("/forget-password/email-otp", ["POST"], "a superseded reset path (C3 §2.2)"),
  blocked("/change-email", ["POST"], "email changes stay blocked ([SA-30])"),
  blocked("/email-otp/change-email", ["POST"], "email changes stay blocked ([SA-30])"),
  blocked("/email-otp/request-email-change", ["POST"], "email changes stay blocked ([SA-30])"),
  blocked("/delete-user", ["POST"], "account deletion is not offered"),
  blocked("/delete-user/callback", ["GET"], "account deletion is not offered"),
  blocked("/update-user", ["POST"], "Fin's own PATCH /api/account/name instead"),
  blocked("/update-session", ["POST"], "Fin's own routes instead"),
  blocked("/verify-password", ["POST"], "a password oracle"),
  blocked("/list-sessions", ["GET"], "Fin's own paged route (§14.2)"),
  blocked("/list-accounts", ["GET"], "Fin's own route"),
  blocked("/revoke-session", ["POST"], "Fin's own route with an intent (§14.2)"),
  blocked("/revoke-sessions", ["POST"], "Fin's own route with an intent (§14.2)"),
  blocked("/revoke-other-sessions", ["POST"], "Fin's own route with an intent (§14.2)"),
  blocked("/get-access-token", ["POST"], "no Google token is handed out"),
  blocked("/refresh-token", ["POST"], "no Google token is handed out"),
  blocked("/account-info", ["GET"], "no Google token is handed out"),
  blocked("/two-factor/get-totp-uri", ["POST"], "reveals the secret after set-up"),
  blocked("/two-factor/send-otp", ["POST"], "no email second factor"),
  blocked("/two-factor/verify-otp", ["POST"], "no email second factor"),
  blocked("/passkey/list-user-passkeys", ["GET"], "Fin's own route"),
  blocked("/passkey/update-passkey", ["POST"], "passkeys are not renamed at launch (S2-30)"),
];

export interface PolicyFeatures {
  passwords: boolean;
  google: boolean;
}

function developerRules(features: PolicyFeatures): EndpointRule[] {
  const rules: EndpointRule[] = [
    rule("/get-session", ["GET", "POST"], "public", ANY, "default", "read only"),
    rule("/sign-out", ["POST"], "public", ANY, "default", "body-less POST; writes session.ended"),
    rule("/error", ["GET"], "public", ANY, "default", "the library's error page"),
    rule(
      "/email-otp/send-verification-otp",
      ["POST"],
      "public",
      ANY,
      "code_send",
      "type sign-in only; the same answer for every address",
    ),
    rule(
      "/sign-in/email-otp",
      ["POST"],
      "public",
      ANY,
      "code_sign_in",
      "makes an account for an unknown address only in the asking browser",
    ),
    rule(
      "/passkey/generate-authenticate-options",
      ["GET"],
      "public",
      ANY,
      "default",
      "a GET counts no Fin budget (§2.3); passkey_options counts at verify-authentication",
    ),
    rule(
      "/passkey/verify-authentication",
      ["POST"],
      "public",
      ANY,
      "passkey_options",
      "an aal2 session; replaces the caller's on a step-up (§11.3)",
    ),
    rule(
      "/two-factor/verify-totp",
      ["POST"],
      "public",
      ["factor_step", "hold", "ok"],
      "factor_code",
      "the signed-in branch: the factor step, step-up and finishing set-up",
    ),
    rule(
      "/two-factor/verify-backup-code",
      ["POST"],
      "public",
      ["factor_step", "ok"],
      "factor_code",
      "",
    ),
    rule(
      "/passkey/generate-register-options",
      ["GET"],
      "step_up_self",
      ["hold", "ok"],
      "default",
      "the first factor under the first-factor rule, later ones with an intent (§7.6) that this GET only checks: verify-registration makes it and counts method_add (§2.3)",
    ),
    rule(
      "/passkey/verify-registration",
      ["POST"],
      "step_up_self",
      ["hold", "ok"],
      "method_add",
      "",
    ),
    rule(
      "/two-factor/enable",
      ["POST"],
      "step_up_self",
      ["hold", "ok"],
      "method_add",
      "finished by /two-factor/verify-totp",
    ),
    rule("/two-factor/disable", ["POST"], "step_up_self", ["ok"], null, "the last-factor rule"),
    rule("/two-factor/generate-backup-codes", ["POST"], "step_up_self", ["ok"], "backup_codes", ""),
    rule("/passkey/delete-passkey", ["POST"], "step_up_self", ["ok"], null, "the last-factor rule"),
  ];
  rules.push(
    features.passwords
      ? rule("/sign-in/email", ["POST"], "public", ANY, "password_sign_in", "§5.7")
      : blocked("/sign-in/email", ["POST"], "passwords are not enabled (stretch 2)"),
    features.passwords
      ? rule("/email-otp/request-password-reset", ["POST"], "public", ANY, "code_send", "§5.7")
      : blocked("/email-otp/request-password-reset", ["POST"], "passwords are not enabled"),
    features.passwords
      ? rule("/email-otp/reset-password", ["POST"], "public", ANY, "code_sign_in", "§5.7")
      : blocked("/email-otp/reset-password", ["POST"], "passwords are not enabled"),
    features.passwords
      ? rule("/change-password", ["POST"], "step_up_self", ["ok"], "method_add", "§5.7")
      : blocked("/change-password", ["POST"], "passwords are not enabled"),
    features.google
      ? rule("/sign-in/social", ["POST"], "public", ANY, "default", "§5.8")
      : blocked("/sign-in/social", ["POST"], "Google is not enabled (stretch 5)"),
    features.google
      ? rule("/callback/:id", ["GET"], "public", ANY, "default", "callback/google only (§5.8)")
      : blocked("/callback/:id", ["GET", "POST"], "Google is not enabled"),
    features.google
      ? rule("/link-social", ["POST"], "step_up_self", ["ok"], "method_add", "§5.8")
      : blocked("/link-social", ["POST"], "Google is not enabled"),
    features.google
      ? rule("/unlink-account", ["POST"], "step_up_self", ["ok"], "method_add", "§5.8")
      : blocked("/unlink-account", ["POST"], "Google is not enabled"),
  );
  return [...rules, ...BLOCKED_BOTH];
}

function staffRules(features: PolicyFeatures): EndpointRule[] {
  const rules: EndpointRule[] = [
    rule("/get-session", ["GET", "POST"], "public", ANY, "default", ""),
    rule("/sign-out", ["POST"], "public", ANY, "default", ""),
    rule(
      "/email-otp/send-verification-otp",
      ["POST"],
      "public",
      ANY,
      "staff_code_send",
      "type sign-in only; sends only to an eligible address (§10.5); the same answer always",
    ),
    rule(
      "/sign-in/email-otp",
      ["POST"],
      "public",
      ANY,
      "staff_code_sign_in",
      "disableSignUp; an aal1 session that lives 10 minutes",
    ),
    rule(
      "/passkey/generate-authenticate-options",
      ["GET"],
      "public",
      ANY,
      "default",
      "a GET counts no Fin budget (§2.3); passkey_options counts at verify-authentication",
    ),
    rule(
      "/passkey/verify-authentication",
      ["POST"],
      "public",
      ANY,
      "passkey_options",
      "aal2 when the passkey's staff member equals the Access identity",
    ),
    rule(
      "/two-factor/verify-totp",
      ["POST"],
      "public",
      ["factor_step", "pending", "ok"],
      "factor_code",
      "needs a session; the challenge branch is unreachable (no passwords)",
    ),
    rule(
      "/passkey/generate-register-options",
      ["GET"],
      "step_up_self",
      ["pending", "ok"],
      "default",
      "pending inside the enrolment window; working with an intent (§10.3) that this GET only checks (§2.3)",
    ),
    rule(
      "/passkey/verify-registration",
      ["POST"],
      "step_up_self",
      ["pending", "ok"],
      "method_add",
      "",
    ),
    rule(
      "/two-factor/enable",
      ["POST"],
      "step_up_self",
      ["pending", "ok"],
      "method_add",
      "refused for a pending member in production: the first factor is a passkey ([SA-04])",
    ),
    rule("/two-factor/disable", ["POST"], "step_up_self", ["ok"], null, "the last factor stays"),
    rule(
      "/passkey/delete-passkey",
      ["POST"],
      "step_up_self",
      ["ok"],
      null,
      "the last factor stays",
    ),
    blocked("/two-factor/generate-backup-codes", ["POST"], "no backup codes for staff ([SA-04])"),
    blocked("/two-factor/verify-backup-code", ["POST"], "no backup codes for staff ([SA-04])"),
    blocked("/sign-in/email", ["POST"], "no passwords for staff"),
    blocked("/change-password", ["POST"], "no passwords for staff"),
    blocked("/email-otp/request-password-reset", ["POST"], "no passwords for staff"),
    blocked("/email-otp/reset-password", ["POST"], "no passwords for staff"),
    blocked("/link-social", ["POST"], "no account linking for staff"),
    blocked("/unlink-account", ["POST"], "no account linking for staff"),
    blocked("/error", ["GET"], "the staff realm shows no library page"),
    features.google
      ? rule(
          "/sign-in/social",
          ["POST"],
          "public",
          ANY,
          "default",
          "§5.8: the Workspace client; a first factor only (google/staff.ts)",
        )
      : blocked("/sign-in/social", ["POST"], "staff Google is off (its own switch, [SA-15])"),
    features.google
      ? rule("/callback/:id", ["GET"], "public", ANY, "default", "callback/google only")
      : blocked("/callback/:id", ["GET", "POST"], "staff Google is off"),
  ];
  return [...rules, ...BLOCKED_BOTH];
}

export interface EndpointPolicy {
  readonly realm: RealmName;
  readonly rules: readonly EndpointRule[];
  readonly features: PolicyFeatures;
  /**
   * The rule for a raw path after `/api/auth` and a method, or null when unlisted. A pattern rule
   * is reached only through the paths it stands for (`/callback/google` while Google is on).
   */
  match(path: string, method: string): EndpointRule | null;
  /** The blocked paths without parameters, for the library's `disabledPaths` second layer. */
  disabledPaths(): string[];
}

/** Indexes rules by path; listing a path twice throws at start-up (§4.1). */
export function indexRules(
  realm: string,
  rules: readonly EndpointRule[],
): Map<string, EndpointRule> {
  const byPath = new Map<string, EndpointRule>();
  for (const r of rules) {
    if (byPath.has(r.path)) throw new Error(`endpoint policy lists ${r.path} twice (${realm})`);
    byPath.set(r.path, r);
  }
  return byPath;
}

export function createEndpointPolicy(realm: RealmName, features: PolicyFeatures): EndpointPolicy {
  const rules = realm === "developer" ? developerRules(features) : staffRules(features);
  const byPath = indexRules(realm, rules);
  return {
    realm,
    rules,
    features,
    match(path, method) {
      // A rule's pattern (`/callback/:id`, `/reset-password/:token`) names a route, never a path
      // a request may use as it is: a raw path with a colon is unlisted.
      if (path.includes(":")) return null;
      let found = byPath.get(path);
      if (found === undefined && features.google && path === "/callback/google") {
        found = byPath.get("/callback/:id");
      }
      if (found === undefined) return null;
      return found.methods.includes(method.toUpperCase() as HttpMethod) ? found : null;
    },
    disabledPaths() {
      return rules.filter((r) => r.class === "blocked" && !r.path.includes(":")).map((r) => r.path);
    },
  };
}

/** The `/api/auth`-relative path of a request URL, or null when it is not under the base path. */
export function authPathOf(requestUrl: string, basePath = "/api/auth"): string | null {
  let pathname: string;
  try {
    pathname = new URL(requestUrl).pathname;
  } catch {
    return null;
  }
  if (!pathname.startsWith(`${basePath}/`)) return null;
  return pathname.slice(basePath.length);
}
