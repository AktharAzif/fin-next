// Email Sending (spec 01 §7.8, R3, [EM-05], [EM-06], [EM-08]).
//
// `pnpm fin email domains <env>`: the `auth.` and `notify.` sending subdomains, each with preview
// and drop-suppressed off, and their own DMARC records (`_dmarc.auth`, `_dmarc.notify`) at the
// overlay's policy (p=none) with aggregate reports to the overlay's `dmarc.rua`. The zone's own
// `_dmarc` is never written (the guard refuses it), and a sending domain is never removed.
//
// `pnpm fin email token <env>`: mints the account-owned Email Sending token (one permission group,
// this account only, a client IP filter to `worker`'s static egress, an expiry of at most 180 days)
// and sets it as `worker`'s sealed FIN_EMAIL_TOKEN with the plain FIN_EMAIL_ACCOUNT_ID and
// FIN_EMAIL_FROM. An existing token of the same name is kept unless --rotate: then the new one is
// minted and set first, and only afterwards are the old ones revoked.

import type { Command } from "../command.ts";
import { flagBool } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import type { Change } from "../core/plan.ts";
import { Secret } from "../core/secret.ts";
import { cloudflare, railway } from "./common.ts";

interface SendingDomain {
  tag?: string;
  id?: string;
  name: string;
  preview_enabled?: boolean;
  drop_suppressed_recipients?: boolean;
}

interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  meta?: { read_only?: boolean };
}

const SENDING_SETTINGS = { preview_enabled: false, drop_suppressed_recipients: false } as const;

function sendingHost(ctx: Context, name: string): string {
  const host = ctx.overlay.emailSubdomains[name];
  if (host === undefined) throw new ConfigError(`the overlay has no emailSubdomains.${name}`);
  ctx.guard.checkName(host, "Email Sending domain");
  return host;
}

/** The DMARC record for a sending subdomain: `v=DMARC1; p=<policy>; rua=<rua>`. */
export function dmarcRecord(policy: string, rua: string): string {
  return `v=DMARC1; p=${policy}; rua=${rua}`;
}

function dmarcPolicy(ctx: Context): string {
  const raw = (ctx.overlay.dmarc.policy ?? ctx.settings.email.dmarcPolicy)
    .replace(/^p=/, "")
    .trim();
  if (!["none", "quarantine", "reject"].includes(raw)) {
    throw new ConfigError("the overlay's dmarc.policy must be none, quarantine or reject");
  }
  return raw;
}

export const emailDomains: Command = {
  words: ["email", "domains"],
  summary: "onboard the auth. and notify. sending subdomains and their own DMARC records",
  positionals: [],
  flags: [],
  overlay: true,
  mutating: true,
  runbook: "email-sending.md",
  async run(ctx) {
    const { api, writer, zonePath } = cloudflare(ctx);
    const current = await api.list<SendingDomain>(`${zonePath}/email/sending/subdomains`);
    const ids = new Map<string, string>();
    const changes: Change[] = [];
    for (const name of ctx.settings.email.subdomains) {
      const host = sendingHost(ctx, name);
      const found = current.find((d) => d.name.toLowerCase() === host.toLowerCase());
      if (found === undefined) {
        changes.push({
          kind: "email-domain",
          name: host,
          action: "create",
          detail: "then preview and drop-suppressed off",
        });
        continue;
      }
      ids.set(host, found.tag ?? found.id ?? "");
      const fields = Object.entries(SENDING_SETTINGS)
        .filter(([key, value]) => found[key as keyof SendingDomain] !== value)
        .map(([key]) => key);
      changes.push({
        kind: "email-domain",
        name: host,
        action: fields.length === 0 ? "keep" : "update",
        ...(fields.length === 0 ? {} : { fields }),
      });
    }

    const policy = dmarcPolicy(ctx);
    const rua = ctx.overlay.dmarc.rua;
    const records = new Map<string, { id?: string; content: string }>();
    for (const label of ctx.overlay.dmarc.records) {
      const name = `${label}.${ctx.overlay.zone}`;
      ctx.guard.checkName(name, "DMARC record");
      if (!label.startsWith("_dmarc."))
        throw new RefusedError(`dmarc.records holds ${label}, which is not a _dmarc record`);
      const content = rua === undefined ? "" : dmarcRecord(policy, rua);
      const found = (
        await api.list<DnsRecord>(`${zonePath}/dns_records`, { type: "TXT", name })
      ).filter(
        (r) =>
          r.name.toLowerCase() === name.toLowerCase() &&
          r.content.replace(/^"|"$/g, "").startsWith("v=DMARC1"),
      );
      if (found.length > 1)
        throw new RefusedError(`${name} holds ${found.length} DMARC records; resolve it by hand`);
      const existing = found[0];
      const detail = `TXT p=${policy}${rua === undefined ? "" : " with aggregate reports"}`;
      const change: Change = { kind: "dmarc", name, action: "create", detail };
      if (existing !== undefined) {
        records.set(name, { id: existing.id, content });
        const same = existing.content.replace(/^"|"$/g, "") === content;
        change.action = same ? "keep" : "update";
        if (!same) change.fields = ["content"];
        if (!same && existing.meta?.read_only === true)
          change.held = "the record is locked by Email Sending";
      } else records.set(name, { content });
      if (rua === undefined && change.action !== "keep") {
        change.held =
          "the overlay has no dmarc.rua (the aggregate report address); the record stays as it is";
      }
      changes.push(change);
    }

    return ctx.applyPlan("email domains", changes, async (change) => {
      if (change.kind === "email-domain") {
        const target = { kind: "email-domain" as const, name: change.name };
        let id = ids.get(change.name);
        if (change.action === "create") {
          const created = await writer.write<SendingDomain>(
            target,
            "POST",
            `${zonePath}/email/sending/subdomains`,
            { name: change.name },
          );
          id = created.tag ?? created.id;
        }
        if (id === undefined || id === "")
          throw new Error("Email Sending answered no subdomain identifier");
        await writer.write(
          target,
          "PATCH",
          `${zonePath}/email/sending/subdomains/${id}`,
          SENDING_SETTINGS,
        );
        return;
      }
      const record = records.get(change.name);
      if (record === undefined) return;
      const body = {
        type: "TXT",
        name: change.name,
        content: record.content,
        ttl: 1,
        comment: "fin-next: pnpm fin email domains",
      };
      if (record.id === undefined)
        await writer.write(
          { kind: "dns", name: change.name },
          "POST",
          `${zonePath}/dns_records`,
          body,
        );
      else
        await writer.write(
          { kind: "dns", name: change.name },
          "PATCH",
          `${zonePath}/dns_records/${record.id}`,
          body,
        );
    });
  },
};

interface PermissionGroup {
  id: string;
  name: string;
}

interface ApiToken {
  id: string;
  name: string;
  status?: string;
  value?: string;
}

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** The body of the token mint: one group, this account, the IP filter, the expiry. */
export function tokenBody(
  name: string,
  accountId: string,
  groupId: string,
  addresses: readonly string[],
  notBefore: Date,
  expiryDays: number,
): Record<string, unknown> {
  const iso = (d: Date) => `${d.toISOString().slice(0, 19)}Z`;
  return {
    name,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        permission_groups: [{ id: groupId }],
      },
    ],
    condition: { request_ip: { in: addresses.map((a) => (a.includes("/") ? a : `${a}/32`)) } },
    not_before: iso(notBefore),
    expires_on: iso(new Date(notBefore.getTime() + expiryDays * 86_400_000)),
  };
}

export const emailToken: Command = {
  words: ["email", "token"],
  summary: "mint the IP-filtered Email Sending token and set it sealed on worker",
  positionals: [],
  flags: [
    {
      name: "rotate",
      kind: "boolean",
      description: "mint a new token even if one exists, then revoke the old",
    },
  ],
  overlay: true,
  mutating: true,
  runbook: "email-sending.md",
  async run(ctx) {
    const t = ctx.settings.email.token;
    ctx.guard.checkOwnName(t.name, "API token");
    const { api, writer, accountPath } = cloudflare(ctx);
    const rw = railway(ctx);
    await rw.serviceId(t.service);

    const groups = await api.list<PermissionGroup>(`${accountPath}/tokens/permission_groups`);
    const group = groups.filter((g) => g.name === t.permissionGroup);
    if (group.length !== 1) {
      const near = groups.filter((g) => g.name.startsWith("Email Sending")).map((g) => g.name);
      throw new ConfigError(
        `no single permission group named ${t.permissionGroup} (found: ${near.join(", ") || "none"})`,
      );
    }
    const groupId = group[0]?.id ?? "";

    let addresses = [...(ctx.overlay.staticEgress[t.service] ?? [])];
    if (addresses.length === 0) addresses = await rw.egressAddresses(t.service);
    if (addresses.length === 0 || addresses.some((a) => !IPV4.test(a))) {
      throw new ConfigError(
        `no static egress IPv4 addresses for ${t.service} (overlay staticEgress.${t.service}); the token is never minted without its IP filter`,
      );
    }
    for (const a of addresses) ctx.masker.register(a, `<egress:${t.service}>`);

    const existing = (await api.list<ApiToken>(`${accountPath}/tokens`)).filter(
      (k) => k.name === t.name,
    );
    const rotate = flagBool(ctx.args, "rotate");
    const changes: Change[] = [];
    const detail = `${t.permissionGroup}, this account only, ${addresses.length} egress address(es), ${t.expiryDays} days`;
    if (existing.length > 0 && !rotate) {
      changes.push({
        kind: "token",
        name: t.name,
        action: "keep",
        detail: "exists; pass --rotate to replace it",
      });
    } else {
      changes.push({ kind: "token", name: t.name, action: "create", detail });
      changes.push({
        kind: "variables",
        name: t.service,
        action: "update",
        detail: `${t.variable} (sealed), FIN_EMAIL_ACCOUNT_ID, FIN_EMAIL_FROM`,
      });
      for (const old of existing)
        changes.push({
          kind: "token-revoke",
          name: `${t.name} (${old.id.slice(0, 6)})`,
          action: "update",
          detail: "revoked after the new token is set",
        });
    }
    let minted: Secret | undefined;
    const target = { kind: "token" as const, name: t.name, permissionGroups: [t.permissionGroup] };
    return ctx.applyPlan("email token", changes, async (change) => {
      if (change.kind === "token") {
        const created = await writer.write<ApiToken>(
          target,
          "POST",
          `${accountPath}/tokens`,
          tokenBody(
            t.name,
            ctx.overlay.cloudflare.accountId,
            groupId,
            addresses,
            ctx.runtime.now(),
            t.expiryDays,
          ),
        );
        if (typeof created.value !== "string" || created.value === "")
          throw new Error("Cloudflare answered no token value");
        ctx.masker.register(created.value, "<email-token>");
        minted = new Secret(created.value);
        return;
      }
      if (change.kind === "variables") {
        if (minted === undefined) throw new Error("no token was minted");
        const from = `account-security@${ctx.overlay.emailSubdomains.auth ?? ""}`;
        await rw.setVariables(
          ctx.run,
          ctx.settings,
          t.service,
          {
            [t.variable]: minted,
            FIN_EMAIL_ACCOUNT_ID: ctx.overlay.cloudflare.accountId,
            FIN_EMAIL_FROM: from,
          },
          `pnpm fin email token (${ctx.run.id})`,
        );
        return;
      }
      const old = existing.find((k) => change.name.endsWith(`(${k.id.slice(0, 6)})`));
      if (old !== undefined)
        await writer.write(target, "DELETE", `${accountPath}/tokens/${old.id}`);
    });
  },
};
