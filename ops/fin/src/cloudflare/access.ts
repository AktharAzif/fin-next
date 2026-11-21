// `pnpm fin access apply <env>` (spec 01 §7.7, ARCHITECTURE §5.10, [FD-05], EXECUTION §2.5 step 9):
// one self-hosted Access application on the staff (admin) host, covering the whole host, static files
// and `/api/*` alike, and one reusable Allow policy. Nobody builds either by hand.
//
// The policy includes exactly the overlay's `access.staff` addresses and `access.allowDomains`
// email domains (the owner's staging decision of 21 Nov: the company domain with One-time PIN), and
// nothing else: never "Everyone", never a bare login-method include. The application allows only the
// account's One-time PIN login method, with an 8-hour session, the binding cookie, an HTTP-only,
// SameSite=Lax cookie, and no App Launcher tile.
//
// `pnpm fin` never creates a login method: on an account another product shares, a new method would
// also appear on that product's applications that allow every method. If the account has no
// One-time PIN method, the command stops and says so (CR-07, the owner's Zero Trust settings).

import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import { hostOf } from "../core/overlay.ts";
import { type Change, canonical, differingFields } from "../core/plan.ts";
import { cloudflare } from "./common.ts";
import { accessPolicyHash } from "./hash.ts";

interface IdentityProvider {
  id: string;
  type: string;
  name?: string;
}

interface Policy {
  id: string;
  name: string;
  decision?: string;
  include?: unknown[];
  exclude?: unknown[];
  require?: unknown[];
}

interface AccessApp {
  id: string;
  name: string;
  domain?: string;
  aud?: string;
  type?: string;
  [field: string]: unknown;
}

export function desiredPolicy(ctx: Context): Record<string, unknown> {
  const include = [
    ...[...ctx.overlay.access.staff].sort().map((email) => ({ email: { email } })),
    ...[...ctx.overlay.access.allowDomains].sort().map((domain) => ({ email_domain: { domain } })),
  ];
  if (include.length === 0) {
    throw new ConfigError(
      "the overlay's access.staff and access.allowDomains are both empty; Access would admit nobody",
    );
  }
  return { name: ctx.settings.access.policy, decision: "allow", include, exclude: [], require: [] };
}

export function desiredApp(ctx: Context, idp: string, policyId: string): Record<string, unknown> {
  const host = hostOf(ctx.overlay, ctx.settings.access.host);
  return {
    name: ctx.settings.access.application,
    type: "self_hosted",
    domain: host,
    destinations: [{ type: "public", uri: host }],
    session_duration: ctx.settings.access.sessionDuration,
    app_launcher_visible: false,
    http_only_cookie_attribute: true,
    same_site_cookie_attribute: "lax",
    enable_binding_cookie: true,
    allowed_idps: [idp],
    auto_redirect_to_identity: true,
    policies: [{ id: policyId, precedence: 1 }],
  };
}

function includeKey(policy: { include?: unknown[] }): string {
  return canonical([...(policy.include ?? [])].map((i) => canonical(i)).sort());
}

function appFields(app: Record<string, unknown>): Record<string, unknown> {
  const policies = Array.isArray(app.policies)
    ? (app.policies as Array<Record<string, unknown>>).map((p) => ({
        id: p.id,
        precedence: p.precedence,
      }))
    : [];
  return {
    type: app.type,
    domain: app.domain,
    destinations: Array.isArray(app.destinations)
      ? (app.destinations as Array<Record<string, unknown>>).map((d) => ({
          type: d.type,
          uri: d.uri,
        }))
      : [],
    session_duration: app.session_duration,
    app_launcher_visible: app.app_launcher_visible,
    http_only_cookie_attribute: app.http_only_cookie_attribute,
    same_site_cookie_attribute: app.same_site_cookie_attribute,
    enable_binding_cookie: app.enable_binding_cookie,
    allowed_idps: app.allowed_idps,
    auto_redirect_to_identity: app.auto_redirect_to_identity,
    policies,
  };
}

export const accessApply: Command = {
  words: ["access", "apply"],
  summary: "apply the Access application on the staff host and its Allow policy",
  positionals: [],
  flags: [],
  overlay: true,
  mutating: true,
  runbook: "access-apply.md",
  async run(ctx) {
    const { api, writer, accountPath } = cloudflare(ctx);
    const host = hostOf(ctx.overlay, ctx.settings.access.host);
    ctx.guard.checkName(host, "Access application");
    ctx.guard.checkOwnName(ctx.settings.access.application, "Access application");
    ctx.guard.checkOwnName(ctx.settings.access.policy, "Access policy");

    const idps = await api.list<IdentityProvider>(`${accountPath}/access/identity_providers`);
    const otp = idps.filter((i) => i.type === ctx.settings.access.identityProvider);
    if (otp.length !== 1) {
      throw new ConfigError(
        `the account has ${otp.length} One-time PIN login methods; it needs exactly one (add it in Zero Trust, CR-07; pnpm fin never creates one)`,
      );
    }
    const idp = otp[0]?.id ?? "";

    const policies = await api.list<Policy>(`${accountPath}/access/policies`);
    const named = policies.filter((p) => p.name === ctx.settings.access.policy);
    if (named.length > 1)
      throw new RefusedError(`two Access policies are named ${ctx.settings.access.policy}`);
    let policy = named[0];
    const wantPolicy = desiredPolicy(ctx);

    const apps = await api.list<AccessApp>(`${accountPath}/access/apps`);
    const onHost = apps.filter((a) => (a.domain ?? "").toLowerCase() === host.toLowerCase());
    const foreign = onHost.find((a) => a.name !== ctx.settings.access.application);
    if (foreign !== undefined) {
      throw new RefusedError(
        `another Access application (${foreign.name}) already covers ${host}; resolve it by hand`,
      );
    }
    const byName = apps.filter((a) => a.name === ctx.settings.access.application);
    if (byName.length > 1)
      throw new RefusedError(
        `two Access applications are named ${ctx.settings.access.application}`,
      );
    let app = byName[0];
    if (app?.aud !== undefined) ctx.masker.register(app.aud, "<access-aud>");

    const changes: Change[] = [];
    const policyDetail = `allow: ${ctx.overlay.access.staff.length} address(es), ${ctx.overlay.access.allowDomains.length} domain(s)`;
    if (policy === undefined)
      changes.push({
        kind: "access-policy",
        name: ctx.settings.access.policy,
        action: "create",
        detail: policyDetail,
      });
    else {
      const fields: string[] = [];
      if (policy.decision !== "allow") fields.push("decision");
      if (includeKey(policy) !== includeKey(wantPolicy as { include: unknown[] }))
        fields.push("include");
      if ((policy.exclude ?? []).length > 0) fields.push("exclude");
      if ((policy.require ?? []).length > 0) fields.push("require");
      changes.push({
        kind: "access-policy",
        name: policy.name,
        action: fields.length === 0 ? "keep" : "update",
        detail: policyDetail,
        ...(fields.length === 0 ? {} : { fields }),
      });
    }
    const appDetail = `self-hosted on ${host} (the whole host), ${ctx.settings.access.sessionDuration}, binding cookie, HttpOnly, SameSite=Lax, One-time PIN, not in the App Launcher`;
    if (app === undefined)
      changes.push({
        kind: "access-app",
        name: ctx.settings.access.application,
        action: "create",
        detail: appDetail,
      });
    else {
      const fields = differingFields(
        appFields(app),
        appFields(desiredApp(ctx, idp, policy?.id ?? "")),
      );
      changes.push({
        kind: "access-app",
        name: app.name,
        action: fields.length === 0 ? "keep" : "update",
        detail: appDetail,
        ...(fields.length === 0 ? {} : { fields }),
      });
    }

    return ctx.applyPlan(
      "access",
      changes,
      async (change) => {
        if (change.kind === "access-policy") {
          const target = { kind: "access-policy" as const, name: ctx.settings.access.policy };
          policy =
            change.action === "create"
              ? await writer.write<Policy>(
                  target,
                  "POST",
                  `${accountPath}/access/policies`,
                  wantPolicy,
                )
              : await writer.write<Policy>(
                  target,
                  "PUT",
                  `${accountPath}/access/policies/${policy?.id}`,
                  wantPolicy,
                );
          return;
        }
        if (policy === undefined) throw new Error("the Access policy does not exist");
        const body = desiredApp(ctx, idp, policy.id);
        const target = { kind: "access-app" as const, name: ctx.settings.access.application, host };
        app =
          change.action === "create"
            ? await writer.write<AccessApp>(target, "POST", `${accountPath}/access/apps`, body)
            : await writer.write<AccessApp>(
                target,
                "PUT",
                `${accountPath}/access/apps/${app?.id}`,
                body,
              );
        if (app.aud !== undefined) ctx.masker.register(app.aud, "<access-aud>");
      },
      {},
      async () => {
        // The policies as the application now holds them, hashed as the watcher hashes them.
        if (app === undefined) return {};
        const current = await api.get<AccessApp>(`${accountPath}/access/apps/${app.id}`);
        const hash = accessPolicyHash(
          Array.isArray(current.policies) ? (current.policies as unknown[]) : [],
        );
        ctx.out.info(`access policy hash: ${hash}`);
        return { accessPolicyHash: hash };
      },
    );
  },
};
