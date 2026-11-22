// Email Sending (spec 01 §7.8, R3, [EM-05], [EM-06], [EM-08]).
//
// `pnpm fin email domains <env>`: the `auth.` and `notify.` sending subdomains, each with preview
// and drop-suppressed off, and their own DMARC records (`_dmarc.auth`, `_dmarc.notify`) at the
// environment's policy (p=reject on staging, [BD-17]) with aggregate reports to the overlay's
// `dmarc.rua` (none for now, so the records are held as they are). The zone's own
// `_dmarc` is never written (the guard refuses it), and a sending domain is never removed.
//
// `pnpm fin email token <env>`: mints the account-owned Email Sending token (one permission group,
// this account only, a client IP filter to `worker`'s static egress, an expiry of at most 180 days)
// and sets it as `worker`'s sealed FIN_EMAIL_TOKEN with the plain FIN_EMAIL_ACCOUNT_ID and
// FIN_EMAIL_FROM, in a commit that starts no deployment, read back until it shows. An existing
// token of the same name is kept unless --rotate, or unless it cannot be the one worker holds: a
// token that is no longer active (expired or disabled), or one minted by a run of this command that
// never set it on worker (Cloudflare shows a value only when it mints it, so such a token's value
// is lost). Then, as with --rotate, the new one is minted and set first; when worker has a
// deployment that may hold a token (its variables name FIN_EMAIL_TOKEN, or Cloudflare lists an old
// one), worker is redeployed as a step of its own, waits for SUCCESS and is read back (a rotation,
// rule 2 of the steward's ruling of 22 Nov), and only afterwards are the old ones revoked
// (ARCHITECTURE §4.9: Railway, then verify, then revoke). That is decided by what worker holds,
// not by what Cloudflare lists: a token revoked at Cloudflare first (a leak) is listed no more,
// and worker still runs on it. A first token, on a worker that has never held one, is
// provisioning (rule 1): worker takes it at its next deployment. Tokens are named by ordinal,
// never by ID.

import type { Command } from "../command.ts";
import { flagBool } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { ConfigError, RefusedError } from "../core/errors.ts";
import type { Change } from "../core/plan.ts";
import { Secret } from "../core/secret.ts";
import type { RailwayApi, Written } from "../railway/api.ts";
import { isRefusal, readVariables } from "../railway/inspect.ts";
import { confirmWritten, deployedOf, redeploy, redeployChange } from "../railway/rollout.ts";
import type { WriteTarget } from "./api.ts";
import { bindZone, cloudflare, railway, registerId } from "./common.ts";

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
    const { api, writer } = cloudflare(ctx);
    const zonePath = await bindZone(ctx, api);
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
      const id = found.tag ?? found.id ?? "";
      registerId(ctx, id, "email-domain", name);
      ids.set(host, id);
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
    for (const [index, label] of ctx.overlay.dmarc.records.entries()) {
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
      registerId(ctx, existing?.id, "dns", `dmarc#${index + 1}`);
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

    const recordWrite = (change: Change) => {
      const record = records.get(change.name);
      if (record === undefined) return undefined;
      const target: WriteTarget = {
        kind: "dns",
        name: change.name,
        ...(record.id === undefined ? {} : { id: record.id }),
      };
      const body = {
        type: "TXT",
        name: change.name,
        content: record.content,
        ttl: 1,
        comment: "fin-next: pnpm fin email domains",
      };
      return record.id === undefined
        ? { target, method: "POST" as const, path: `${zonePath}/dns_records`, body }
        : { target, method: "PATCH" as const, path: `${zonePath}/dns_records/${record.id}`, body };
    };

    return ctx.applyPlan(
      "email domains",
      changes,
      async (change) => {
        if (change.kind === "email-domain") {
          let id = ids.get(change.name);
          if (change.action === "create") {
            const created = await writer.write<SendingDomain>(
              { kind: "email-domain", name: change.name },
              "POST",
              `${zonePath}/email/sending/subdomains`,
              { name: change.name },
            );
            id = created.tag ?? created.id;
            registerId(ctx, id, "email-domain");
          }
          if (id === undefined || id === "")
            throw new Error("Email Sending answered no subdomain identifier");
          await writer.write(
            { kind: "email-domain", name: change.name, id },
            "PATCH",
            `${zonePath}/email/sending/subdomains/${id}`,
            SENDING_SETTINGS,
          );
          return;
        }
        const write = recordWrite(change);
        if (write !== undefined)
          await writer.write(write.target, write.method, write.path, write.body);
      },
      {},
      {
        check: (change) => {
          if (change.kind === "email-domain") {
            const id = ids.get(change.name);
            if (change.action === "create" || id === undefined) {
              writer.check(
                { kind: "email-domain", name: change.name },
                "POST",
                `${zonePath}/email/sending/subdomains`,
                { name: change.name },
              );
            } else {
              writer.check(
                { kind: "email-domain", name: change.name, id },
                "PATCH",
                `${zonePath}/email/sending/subdomains/${id}`,
                SENDING_SETTINGS,
              );
            }
            return;
          }
          const write = recordWrite(change);
          if (write !== undefined) writer.check(write.target, write.method, write.path, write.body);
        },
      },
    );
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

/**
 * Whether the last run of `email token` that minted the token stopped before it set it on its
 * service: the run log holds that run's `token create` step and no `variables` step after it. A run
 * log that cannot be read answers false (nothing is known, so nothing is replaced on that ground).
 */
export function mintedButNeverSet(ctx: Context, token: string, service: string): boolean {
  let records: ReturnType<Context["log"]["records"]>;
  try {
    records = ctx.log.records();
  } catch {
    return false;
  }
  const tokenName = ctx.masker.mask(token);
  const serviceName = ctx.masker.mask(service);
  let lastMint: string | undefined;
  for (const r of records) {
    if (
      r.event === "run.step" &&
      r.kind === "token" &&
      r.name === tokenName &&
      r.action === "create"
    )
      lastMint = r.runId;
  }
  if (lastMint === undefined) return false;
  return !records.some(
    (r) =>
      r.runId === lastMint &&
      r.event === "run.step" &&
      r.kind === "variables" &&
      r.name === serviceName,
  );
}

/**
 * Whether the service's running deployment may hold a token, so that a new one reaches it only by
 * a redeploy (rule 2). Read from the service, not from Cloudflare's list: it has a deployment, and
 * its variables name the token (Railway answers a sealed one by its name), or Cloudflare still
 * lists a token of the name it may have started with. A token revoked at Cloudflare first (the
 * leak path of rotate-email-token.md) is listed no more, yet the deployment still runs on it. A
 * variables read Railway refuses leaves it unknown, which counts as holding one: leaving the
 * service on a revoked token stops every send. A service that has never had the variable is
 * provisioned (rule 1).
 */
export async function holdsToken(
  ctx: Context,
  rw: RailwayApi,
  service: string,
  variable: string,
  listed: boolean,
): Promise<boolean> {
  if (!(await deployedOf(ctx, rw, [service])).has(service)) return false;
  if (listed) return true;
  try {
    const v = await readVariables(rw, ctx.settings, service, await rw.serviceId(service));
    return v.sealed.includes(variable) || v.readable.includes(variable);
  } catch (error) {
    if (!isRefusal(error)) throw error;
    ctx.out.warn(
      `Railway refused ${service}'s variables read, so whether its deployment holds ${variable} is unknown: it is redeployed as if it did`,
    );
    return true;
  }
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
    const revoke = new Map<string, ApiToken>();
    existing.forEach((token, i) => {
      registerId(ctx, token.id, "token", `${t.name}#${i + 1}`);
      revoke.set(`${t.name} #${i + 1}`, token);
    });
    const rotate = flagBool(ctx.args, "rotate");
    let replace: string | undefined;
    if (existing.length > 0 && !rotate) {
      const inactive = existing.find((k) => k.status !== undefined && k.status !== "active");
      if (inactive !== undefined) replace = `token ${t.name} is ${inactive.status}`;
      else if (mintedButNeverSet(ctx, t.name, t.service)) {
        replace = `the last token minted by this command was never set on ${t.service}`;
      }
      if (replace !== undefined) ctx.out.info(`${replace}: it is replaced (as with --rotate)`);
    }
    const changes: Change[] = [];
    const detail = `${t.permissionGroup}, this account only, ${addresses.length} egress address(es), ${t.expiryDays} days`;
    if (existing.length > 0 && !rotate && replace === undefined) {
      changes.push({
        kind: "token",
        name: t.name,
        action: "keep",
        detail: "exists; pass --rotate to replace it",
      });
    } else {
      changes.push({
        kind: "token",
        name: t.name,
        action: "create",
        detail: replace === undefined ? detail : `${detail}; replaces it: ${replace}`,
      });
      changes.push({
        kind: "variables",
        name: t.service,
        action: "update",
        detail: `${t.variable} (sealed), FIN_EMAIL_ACCOUNT_ID, FIN_EMAIL_FROM; a commit that starts no deployment, read back`,
      });
      // A rotation: the old tokens are revoked only once the service that may hold one runs the
      // new token (rule 2). A service with no deployment holds none.
      const holds = await holdsToken(ctx, rw, t.service, t.variable, revoke.size > 0);
      if (holds) changes.push(redeployChange(t.service, [t.variable]));
      for (const name of revoke.keys())
        changes.push({
          kind: "token-revoke",
          name,
          action: "update",
          detail: holds
            ? `revoked once ${t.service} runs the new token, read back`
            : `revoked after the new token is set (${t.service} has no deployment that holds the old one)`,
        });
    }
    let minted: Secret | undefined;
    let written: Written | undefined;
    const target = (id?: string): WriteTarget => ({
      kind: "token",
      name: t.name,
      permissionGroups: [{ name: t.permissionGroup, id: groupId }],
      ...(id === undefined ? {} : { id }),
    });
    const mint = tokenBody(
      t.name,
      ctx.overlay.cloudflare.accountId,
      groupId,
      addresses,
      ctx.runtime.now(),
      t.expiryDays,
    );
    return ctx.applyPlan(
      "email token",
      changes,
      async (change) => {
        if (change.kind === "token") {
          const created = await writer.write<ApiToken>(
            target(),
            "POST",
            `${accountPath}/tokens`,
            mint,
          );
          if (typeof created.value !== "string" || created.value === "")
            throw new Error("Cloudflare answered no token value");
          ctx.masker.register(created.value, "<email-token>");
          registerId(ctx, created.id, "token", `${t.name}#new`);
          minted = new Secret(created.value);
          return;
        }
        if (change.kind === "variables") {
          if (minted === undefined) throw new Error("no token was minted");
          const from = `account-security@${ctx.overlay.emailSubdomains.auth ?? ""}`;
          written = await rw.setVariables(
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
          await confirmWritten(ctx, rw, written);
          return;
        }
        if (change.kind === "redeploy") {
          if (written === undefined) throw new Error("the new token was not set");
          try {
            await redeploy(ctx, rw, written, [t.variable]);
          } catch (error) {
            ctx.out.error(
              `the rotation is not done: ${t.service} may still run the old token, which is not revoked; once the cause is fixed, run: pnpm fin email token ${ctx.environment} --rotate`,
            );
            throw error;
          }
          return;
        }
        const old = revoke.get(change.name);
        if (old !== undefined)
          await writer.write(target(old.id), "DELETE", `${accountPath}/tokens/${old.id}`);
      },
      {},
      {
        check: (change) => {
          if (change.kind === "token")
            writer.check(target(), "POST", `${accountPath}/tokens`, mint);
          else if (change.kind === "variables" || change.kind === "redeploy") {
            if (ctx.settings.railway.services[t.service] === undefined) {
              throw new RefusedError(
                `railway: ${t.service} is not a service the public settings list`,
              );
            }
          } else {
            const old = revoke.get(change.name);
            if (old !== undefined)
              writer.check(target(old.id), "DELETE", `${accountPath}/tokens/${old.id}`);
          }
        },
      },
    );
  },
};
