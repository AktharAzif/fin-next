// Fin Admin's Access application (spec 01 §7.7, with the owner's staging decision: the company
// domain with one-time PIN): the application's shape, MFA where the settings require it, and the
// policy hash equal to the last registered `pnpm fin access apply`.
import { accessPolicyHash } from "../hash.ts";
import { type Check, type Failure, isRecord, records } from "./common.ts";

function includesEveryone(policy: Record<string, unknown>): boolean {
  return records(policy.include).some((rule) => "everyone" in rule);
}

export const access: Check = {
  name: "access",
  async run(ctx) {
    const failures: Failure[] = [];
    const want = ctx.settings.access;
    const add = (detail: string) =>
      failures.push({ check: "access", target: want.appName, detail });
    const account = ctx.settings.accountId;
    const apps = records(await ctx.cf.list(`/accounts/${account}/access/apps`));
    const app = apps.find((a) => a.name === want.appName);
    if (app === undefined) {
      add("app_missing");
      return failures;
    }
    const host = ctx.settings.hosts[want.host];
    if (app.domain !== host) add("app_domain");
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
