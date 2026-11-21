// `pnpm fin access apply <env>` (spec 01 §7.7, ARCHITECTURE §5.10, [FD-05], EXECUTION §2.5 step 9):
// one self-hosted Access application on the staff (admin) host, covering the whole host, static files
// and `/api/*` alike, and one reusable Allow policy. Nobody builds either by hand.
//
// The policy includes exactly the overlay's `access.staff` addresses and `access.allowDomains`
// email domains (the owner's staging decision of 21 Nov: the company domain with One-time PIN), and
// nothing else: never "Everyone", never a bare login-method include. The application allows only the
// account's One-time PIN login method, with an 8-hour session, the binding cookie, an HTTP-only,
// SameSite=Lax cookie, and no App Launcher tile. It also keeps the three settings that would open it
// in their closed state: OPTIONS is not let past Access, a WARP session does not stand in for the
// sign-in, and Access sends no CORS headers.
//
// An update reads the application or policy as it stands and writes it back with only the managed
// fields changed (a PUT replaces the whole object), so what the owner sets by hand in Zero Trust,
// Access's independent MFA (`mfa_config`, CR-07) above all, survives every run.
//
// Any other application whose domain, self-hosted domains or destinations reach the staff host (the
// host itself, a path under it, or a wildcard over it) is refused: Access applies the most specific
// application for a path, so a foreign one on `/assets` would open that path without Fin's policy.
// Bookmarks only link, so they are left alone.
//
// `pnpm fin` never creates a login method: on an account another product shares, a new method would
// also appear on that product's applications that allow every method. If the account has no
// One-time PIN method, the command stops and says so (CR-07, the owner's Zero Trust settings).

import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import { hostOf } from "../core/overlay.ts";
import { type Change, canonical, differingFields } from "../core/plan.ts";
import { accessDomain, appDomains, type WriteTarget } from "./api.ts";
import { cloudflare, registerId } from "./common.ts";
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
  [field: string]: unknown;
}

interface AccessApp {
  id: string;
  name: string;
  domain?: string;
  aud?: string;
  type?: string;
  [field: string]: unknown;
}

/** Fields Cloudflare sets itself, left out of a write-back. */
const READ_ONLY_FIELDS = ["id", "uid", "aud", "created_at", "updated_at", "app_count", "reusable"];

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
    options_preflight_bypass: false,
    allow_authenticate_via_warp: false,
    policies: [{ id: policyId, precedence: 1 }],
  };
}

/**
 * The body of an update: the object as it stands, with the managed fields written over it and
 * `drop` removed (fields that must be absent), so every setting the owner keeps by hand survives.
 */
export function writeBack(
  current: Record<string, unknown>,
  managed: Record<string, unknown>,
  drop: readonly string[] = [],
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...current };
  for (const field of [...READ_ONLY_FIELDS, ...drop]) delete body[field];
  return { ...body, ...managed };
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
    options_preflight_bypass: app.options_preflight_bypass ?? false,
    allow_authenticate_via_warp: app.allow_authenticate_via_warp ?? false,
    cors_headers: app.cors_headers ?? null,
    // Cloudflare mirrors the destinations here; absent, it is the domain alone.
    self_hosted_domains: Array.isArray(app.self_hosted_domains)
      ? (app.self_hosted_domains as unknown[]).map((d) => accessDomain(String(d)))
      : [accessDomain(String(app.domain ?? ""))],
    policies,
  };
}

/** Whether an Access domain (a host, a path under it, or a wildcard) reaches `host`. */
export function domainCovers(domain: string, host: string): boolean {
  const name = (accessDomain(domain).split("/")[0] ?? "").replace(/:\d+$/, "");
  const want = host.toLowerCase();
  if (name === want) return true;
  if (!name.includes("*")) return false;
  const pattern = name
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\-]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${pattern}$`).test(want);
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
    registerId(ctx, idp, "access-idp");

    const policies = await api.list<Policy>(`${accountPath}/access/policies`);
    const named = policies.filter((p) => p.name === ctx.settings.access.policy);
    if (named.length > 1)
      throw new RefusedError(`two Access policies are named ${ctx.settings.access.policy}`);
    let policy = named[0];
    registerId(ctx, policy?.id, "access-policy");
    const wantPolicy = desiredPolicy(ctx);

    const apps = await api.list<AccessApp>(`${accountPath}/access/apps`);
    const foreign = apps.find(
      (a) =>
        a.name !== ctx.settings.access.application &&
        a.type !== "bookmark" &&
        appDomains(a).some((domain) => domainCovers(domain, host)),
    );
    if (foreign !== undefined) {
      throw new RefusedError(
        `another Access application (${foreign.name}) already covers ${host} or a path under it; resolve it by hand`,
      );
    }
    const byName = apps.filter((a) => a.name === ctx.settings.access.application);
    if (byName.length > 1)
      throw new RefusedError(
        `two Access applications are named ${ctx.settings.access.application}`,
      );
    let app = byName[0];
    registerId(ctx, app?.id, "access-app");
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

    const policyTarget = (): WriteTarget => ({
      kind: "access-policy",
      name: ctx.settings.access.policy,
      ...(policy === undefined ? {} : { id: policy.id }),
    });
    const appTarget = (): WriteTarget => ({
      kind: "access-app",
      name: ctx.settings.access.application,
      host,
      ...(app === undefined ? {} : { id: app.id }),
    });
    // An application is only ever written back without CORS headers and with destinations alone.
    const appDrop = ["cors_headers", "self_hosted_domains"];

    return ctx.applyPlan(
      "access",
      changes,
      async (change) => {
        if (change.kind === "access-policy") {
          if (change.action === "create") {
            policy = await writer.write<Policy>(
              policyTarget(),
              "POST",
              `${accountPath}/access/policies`,
              wantPolicy,
            );
          } else {
            const id = policy?.id ?? "";
            const current = await api.get<Policy>(`${accountPath}/access/policies/${id}`);
            policy = await writer.write<Policy>(
              policyTarget(),
              "PUT",
              `${accountPath}/access/policies/${id}`,
              writeBack(current, wantPolicy),
            );
          }
          registerId(ctx, policy.id, "access-policy");
          return;
        }
        if (policy === undefined) throw new Error("the Access policy does not exist");
        const managed = desiredApp(ctx, idp, policy.id);
        if (change.action === "create") {
          app = await writer.write<AccessApp>(
            appTarget(),
            "POST",
            `${accountPath}/access/apps`,
            managed,
          );
        } else {
          const id = app?.id ?? "";
          const current = await api.get<AccessApp>(`${accountPath}/access/apps/${id}`);
          app = await writer.write<AccessApp>(
            appTarget(),
            "PUT",
            `${accountPath}/access/apps/${id}`,
            writeBack(current, managed, appDrop),
          );
        }
        registerId(ctx, app.id, "access-app");
        if (app.aud !== undefined) ctx.masker.register(app.aud, "<access-aud>");
      },
      {},
      {
        // Checked with the objects as read at plan time; an update's write-back keeps the
        // managed fields over them, so the checked fields are the ones that will be sent.
        check: (change) => {
          if (change.kind === "access-policy") {
            const id = policy?.id ?? "";
            writer.check(
              policyTarget(),
              change.action === "create" ? "POST" : "PUT",
              change.action === "create"
                ? `${accountPath}/access/policies`
                : `${accountPath}/access/policies/${id}`,
              change.action === "create" ? wantPolicy : writeBack(policy ?? {}, wantPolicy),
            );
            return;
          }
          const managed = desiredApp(ctx, idp, policy?.id ?? "");
          writer.check(
            appTarget(),
            change.action === "create" ? "POST" : "PUT",
            change.action === "create"
              ? `${accountPath}/access/apps`
              : `${accountPath}/access/apps/${app?.id ?? ""}`,
            change.action === "create" ? managed : writeBack(app ?? {}, managed, appDrop),
          );
        },
        // The policies as the application now holds them, hashed as the watcher hashes them,
        // into run.done only: a printed hash would let a guessed staff address be confirmed.
        after: async () => {
          if (app === undefined) return {};
          const current = await api.get<AccessApp>(`${accountPath}/access/apps/${app.id}`);
          const hash = accessPolicyHash(
            Array.isArray(current.policies) ? (current.policies as unknown[]) : [],
          );
          return { accessPolicyHash: hash };
        },
      },
    );
  },
};
