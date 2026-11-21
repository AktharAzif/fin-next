// Fin Admin's Access application (spec 01 §7.7, with the owner's staging decision: the company
// domain with one-time PIN): the application's shape, MFA where the settings require it, the
// policy hash equal to the last registered `pnpm fin access apply`, and no other application on
// the admin host. Access applies the most specific application for a path, so a second one on the
// host or a path under it (a bypass on `/assets`, say) would open that path without touching the
// watched application; the static half has no guard but Access (S-01 (i)).
import { accessPolicyHash } from "../hash.ts";
import { hostPatternMatches } from "../settings.ts";
import { type Check, type Failure, isRecord, records } from "./common.ts";

function includesEveryone(policy: Record<string, unknown>): boolean {
  return records(policy.include).some((rule) => "everyone" in rule);
}

/** Every hostname-and-path an application covers: its domain, self-hosted domains, destinations. */
export function appDomains(app: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof app.domain === "string") out.push(app.domain);
  if (Array.isArray(app.self_hosted_domains)) {
    for (const d of app.self_hosted_domains) if (typeof d === "string") out.push(d);
  }
  for (const d of records(app.destinations)) if (typeof d.uri === "string") out.push(d.uri);
  return out;
}

/** An application domain without its scheme or a trailing `/` or `/*`, lowercased. */
function normalDomain(domain: string): string {
  return domain
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/\/\*?$/, "")
    .toLowerCase();
}

export const access: Check = {
  name: "access",
  async run(ctx) {
    const failures: Failure[] = [];
    const want = ctx.settings.access;
    const add = (detail: string) =>
      failures.push({ check: "access", target: want.appName, detail });
    const account = ctx.settings.accountId;
    const host = ctx.settings.hosts[want.host];
    const apps = records(await ctx.cf.list(`/accounts/${account}/access/apps`));
    // Another application on the admin host takes over the paths it names. Bookmarks only link.
    // Its own target (the host role), so a standing failure of the application never hides it.
    const named = apps.filter((a) => a.name === want.appName);
    const overlapping = apps.filter(
      (a) =>
        !named.includes(a) &&
        a.type !== "bookmark" &&
        appDomains(a).some((domain) => hostPatternMatches(domain, host)),
    );
    if (overlapping.length > 0) {
      failures.push({ check: "access", target: want.host, detail: "app_overlap" });
    }
    if (named.length === 0) {
      add("app_missing");
      return failures;
    }
    if (named.length > 1) {
      add("app_duplicate");
      return failures;
    }
    const app = named[0] as Record<string, unknown>;
    // The whole host and nothing else (spec 01 §7.7: static and /api/ alike).
    const domains = appDomains(app).map(normalDomain);
    if (typeof app.domain !== "string" || normalDomain(app.domain) !== host) add("app_domain");
    else if (domains.some((d) => d !== host)) add("app_domain");
    if (app.type !== "self_hosted") add("app_type");
    if (app.session_duration !== want.sessionDuration) add("session_duration");
    if (app.enable_binding_cookie !== want.bindingCookie) add("binding_cookie");
    if (app.http_only_cookie_attribute !== want.httpOnly) add("http_only");
    if (String(app.same_site_cookie_attribute ?? "").toLowerCase() !== want.sameSite) {
      add("same_site");
    }
    if (app.app_launcher_visible !== want.appLauncherVisible) add("launcher_visible");
    if (want.mfaRequired) {
      const mfa = isRecord(app.mfa_config) ? app.mfa_config : undefined;
      const authenticators = Array.isArray(mfa?.allowed_authenticators)
        ? mfa.allowed_authenticators
        : [];
      if (mfa === undefined || mfa.mfa_disabled === true || authenticators.length === 0) {
        add("mfa_not_required");
      }
    }
    const policies = Array.isArray(app.policies)
      ? records(app.policies)
      : records(
          await ctx.cf.list(
            `/accounts/${account}/access/apps/${encodeURIComponent(String(app.id))}/policies`,
          ),
        );
    if (policies.length === 0) add("policy_missing");
    if (policies.some(includesEveryone)) add("policy_everyone");
    if (ctx.settings.accessPolicyHash === null) add("hash_unset");
    else if ((await accessPolicyHash(policies)) !== ctx.settings.accessPolicyHash) {
      add("policy_hash_mismatch");
    }
    return failures;
  },
};
