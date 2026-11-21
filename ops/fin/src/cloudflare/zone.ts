// `pnpm fin zone apply <env>`: the zone settings and Fin's zone rules (spec 01 §7.6, ARCHITECTURE
// §5.6 to §5.8 and §5.11, BD-11, BD-12, BD-13).
//
// Settings: each setting in the public settings is compared with the zone's; on a zone another
// product shares (`zone.shared`), a zone-wide setting is held unless the run passes
// --allow-shared-zone-settings, because it changes that product's hosts too.
//
// Rules: each phase's entrypoint is read; only rules whose ref starts with `fin_next_` are compared,
// created, updated or deleted, each through the per-rule endpoints. A phase entrypoint is created
// only when it does not exist (checked again just before). The optional rate rule is not written
// while the zone is shared ([FD-09]), and otherwise comes last, after every deletion, so its
// refusal never stops a required rule. Every pending write is checked before the run registers.
// After the run, each phase's fin_next_ rules are read back and hashed as the watcher hashes them,
// into `run.done` only (never printed). The private rate threshold is never registered with the
// masker (a short number would rewrite the run's own numbers); it is redacted from the provider
// errors of the rate phase's writes, the only requests that carry it. Ingress proofs keep their
// values; a host with no proof gets a new one (32 random bytes, base64url), which is set sealed on
// the services that check it before the rule that sends it is written (spec 01 §7.6's order).

import type { Command } from "../command.ts";
import { flagBool, flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { RefusedError } from "../core/errors.ts";
import { type HostRole, hostOf } from "../core/overlay.ts";
import { type Change, canonical, differingFields } from "../core/plan.ts";
import { Secret } from "../core/secret.ts";
import type { Redaction, WriteTarget } from "./api.ts";
import { bindZone, cloudflare, railway, registerId } from "./common.ts";
import { finRulesetHash, isFinRule } from "./hash.ts";
import {
  comparable,
  type DesiredRule,
  desiredRules,
  PHASES,
  type Phase,
  PROOF_HEADER,
  ruleBody,
} from "./rules.ts";

interface ZoneSetting {
  id: string;
  value: unknown;
  editable?: boolean;
}

interface Rule {
  id: string;
  ref?: string;
  description?: string;
  expression?: string;
  action?: string;
  action_parameters?: Record<string, unknown>;
  ratelimit?: Record<string, unknown>;
  enabled?: boolean;
}

interface Ruleset {
  id: string;
  rules?: Rule[];
}

interface Write {
  target: WriteTarget;
  method: "POST" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  /** Private values this write alone carries, redacted from its provider error. */
  redact?: readonly Redaction[];
}

const RATE_PHASE: Phase = "http_ratelimit";

const PROOF = /^[A-Za-z0-9_-]{43}$/;

function existingProof(rule: Rule | undefined): string | undefined {
  const headers = rule?.action_parameters?.headers as
    | Record<string, { value?: unknown }>
    | undefined;
  const value = headers?.[PROOF_HEADER]?.value;
  return typeof value === "string" && PROOF.test(value) ? value : undefined;
}

function newProof(ctx: Context): Secret {
  return new Secret(Buffer.from(ctx.runtime.random(32)).toString("base64url"));
}

/** A public label for a Fin rule's ID placeholder: its ref, when the ref is a plain name. */
function ruleLabel(ref: string): string {
  return /^[A-Za-z0-9_-]{1,64}$/.test(ref) ? ref : "fin_next";
}

/** Registers a phase entrypoint's ID and its fin_next_ rules' IDs with the masker. */
function registerRuleset(ctx: Context, phase: Phase, ruleset: Ruleset | undefined): void {
  if (ruleset === undefined) return;
  registerId(ctx, ruleset.id, "ruleset", phase);
  for (const rule of ruleset.rules ?? []) {
    if (isFinRule(rule)) registerId(ctx, rule.id, "rule", ruleLabel(rule.ref ?? ""));
  }
}

/**
 * Each phase's hash of fin-next's own rules as it stands now (spec 01 §7.6: the other product's
 * rules are left out), computed as the watcher computes it, for `run.done`'s `rulesetHashes`.
 */
async function readRulesetHashes(
  ctx: Context,
  api: ReturnType<typeof cloudflare>["api"],
  zonePath: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const phase of PHASES) {
    const ruleset = await api.getOptional<Ruleset>(
      `${zonePath}/rulesets/phases/${phase}/entrypoint`,
    );
    registerRuleset(ctx, phase, ruleset);
    hashes[phase] = finRulesetHash(ruleset?.rules ?? []);
  }
  return hashes;
}

/**
 * Refuses while a proxied wildcard record on the zone (another product's `*.<zone>`) answers for a
 * host that gets an ingress proof and has no record of its own yet: the zone rules come before the
 * hosts' records (EXECUTION §2.5 steps 7 and 8), so until then that host's requests, with Fin's
 * proof attached at the edge, would go to the wildcard's origin. A host's own record, written by
 * `routes apply`, takes precedence over the wildcard. Only reads; the wildcard is never touched.
 */
async function refuseWildcardOrigin(
  ctx: Context,
  api: ReturnType<typeof cloudflare>["api"],
  zonePath: string,
  roles: readonly HostRole[],
): Promise<void> {
  const wildcard = `*.${ctx.overlay.zone}`;
  const records = await api.list<{ name: string; proxied?: boolean }>(`${zonePath}/dns_records`, {
    name: wildcard,
  });
  if (!records.some((r) => r.name.toLowerCase() === wildcard.toLowerCase() && r.proxied === true))
    return;
  const uncovered: string[] = [];
  for (const role of roles) {
    const host = hostOf(ctx.overlay, role);
    const own = await api.list<{ name: string }>(`${zonePath}/dns_records`, { name: host });
    if (!own.some((r) => r.name.toLowerCase() === host.toLowerCase())) uncovered.push(host);
  }
  if (uncovered.length > 0) {
    throw new RefusedError(
      `the proxied wildcard record ${wildcard} answers for ${uncovered.join(", ")}, which have no record of their own yet, so their ingress proofs would reach that record's origin; run routes apply first (it writes their records) or resolve the wildcard by hand`,
    );
  }
}

async function settingChanges(
  ctx: Context,
  api: ReturnType<typeof cloudflare>["api"],
  zonePath: string,
): Promise<Change[]> {
  const desired = ctx.settings.zone.settings;
  const current = await api.get<ZoneSetting[]>(`${zonePath}/settings`);
  const byId = new Map(current.map((s) => [s.id, s]));
  const allowShared = flagBool(ctx.args, "allow-shared-zone-settings");
  const changes: Change[] = [];
  for (const [id, value] of Object.entries(desired)) {
    const now = byId.get(id);
    const detail = `= ${JSON.stringify(value)}`;
    if (now === undefined) {
      changes.push({
        kind: "setting",
        name: id,
        action: "update",
        detail,
        held: "not offered on this zone",
      });
      continue;
    }
    if (canonical(now.value) === canonical(value)) {
      changes.push({ kind: "setting", name: id, action: "keep" });
      continue;
    }
    const change: Change = {
      kind: "setting",
      name: id,
      action: "update",
      detail: `${JSON.stringify(now.value)} -> ${JSON.stringify(value)}`,
    };
    if (now.editable === false) change.held = "not editable on this zone's plan";
    else if (ctx.settings.zone.shared && !allowShared) {
      change.held =
        "the zone is shared, so zone-wide settings change only with --allow-shared-zone-settings";
    }
    changes.push(change);
  }
  return changes;
}

interface RulePlan {
  changes: Change[];
  rules: DesiredRule[];
  entrypoints: Map<Phase, Ruleset | undefined>;
  existing: Map<string, { phase: Phase; rule: Rule }>;
  newProofs: Set<HostRole>;
  proofs: Map<HostRole, Secret>;
  /** The threshold values a write to the rate phase may carry, for its provider error alone. */
  rateRedactions: Redaction[];
}

async function rulePlan(
  ctx: Context,
  api: ReturnType<typeof cloudflare>["api"],
  zonePath: string,
): Promise<RulePlan> {
  const s = ctx.settings;
  const entrypoints = new Map<Phase, Ruleset | undefined>();
  const existing = new Map<string, { phase: Phase; rule: Rule }>();
  for (const phase of PHASES) {
    const ruleset = await api.getOptional<Ruleset>(
      `${zonePath}/rulesets/phases/${phase}/entrypoint`,
    );
    entrypoints.set(phase, ruleset);
    registerRuleset(ctx, phase, ruleset);
    for (const rule of ruleset?.rules ?? []) {
      if (isFinRule(rule) && rule.ref !== undefined) existing.set(rule.ref, { phase, rule });
    }
  }

  const proofRoles: HostRole[] = [s.hostRoles.api, ...s.hostRoles.apiPaths];
  await refuseWildcardOrigin(ctx, api, zonePath, proofRoles);
  const proofs = new Map<HostRole, Secret>();
  const newProofs = new Set<HostRole>();
  for (const role of proofRoles) {
    const current = existingProof(existing.get(`fin_next_ingress_proof_${role}`)?.rule);
    const secret = current === undefined ? newProof(ctx) : new Secret(current);
    ctx.masker.register(secret.reveal(), `<ingress-proof:${role}>`);
    proofs.set(role, secret);
    if (current === undefined) newProofs.add(role);
  }

  // The threshold is private ([OB-13]), and a short number: it is never registered with the masker
  // (which would rewrite every equal number in the run's output and log). Only the writes to the
  // rate phase carry it (the overlay's value, or the value a rate rule of Fin's holds now), so only
  // their provider errors are redacted. On a shared zone nothing sends it.
  const thresholdName = s.rules.rate.threshold;
  const threshold = Object.hasOwn(ctx.overlay.thresholds, thresholdName)
    ? ctx.overlay.thresholds[thresholdName]?.reveal()
    : undefined;
  const placeholder = `<threshold:${s.rules.rate.threshold}>`;
  const held = new Set<number>(threshold === undefined ? [] : [threshold]);
  for (const { phase, rule } of existing.values()) {
    const now = rule.ratelimit?.requests_per_period;
    if (phase === "http_ratelimit" && typeof now === "number") held.add(now);
  }
  const rateRedactions: Redaction[] = [...held].map((n) => ({ value: String(n), placeholder }));
  if (s.zone.shared) {
    ctx.out.info(
      "rate rule: not written while the zone is shared ([FD-09]); Fin's own limits stand alone",
    );
  }
  const pair = (role: HostRole) => ({ role, host: hostOf(ctx.overlay, role) });
  const rules = desiredRules({
    hosts: {
      browser: s.hostRoles.browser.map(pair),
      apiPaths: s.hostRoles.apiPaths.map(pair),
      api: hostOf(ctx.overlay, s.hostRoles.api),
    },
    proofs,
    ...(s.zone.shared
      ? {}
      : {
          rate: {
            pathPrefix: s.rules.rate.pathPrefix,
            periodSeconds: s.rules.rate.periodSeconds,
            mitigationTimeoutSeconds: s.rules.rate.mitigationTimeoutSeconds,
            ...(threshold === undefined ? {} : { threshold }),
          },
        }),
  });
  for (const rule of rules) {
    ctx.guard.checkRuleRef(rule.ref, "zone rule");
    for (const host of rule.hosts) ctx.guard.checkName(host, `zone rule ${rule.ref}`);
  }

  const changes: Change[] = [];
  // The services learn a new proof before any rule sends it.
  for (const [service, roles] of Object.entries(s.ingressProofs)) {
    const fresh = roles.filter((r) => newProofs.has(r));
    if (fresh.length === 0) continue;
    changes.push({
      kind: "variable",
      name: `${service}.FIN_INGRESS_PROOFS`,
      action: "update",
      detail: `sealed; new proof for ${fresh.join(", ")}`,
    });
  }
  const ruleChange = (rule: DesiredRule): Change => {
    const found = existing.get(rule.ref);
    const name = `${rule.phase}/${rule.ref}`;
    const held = rule.held === undefined ? {} : { held: rule.held };
    if (found === undefined) return { kind: "rule", name, action: "create", ...held };
    const fields = differingFields(comparable(found.rule), comparable({ ...ruleBody(rule) }));
    if (found.phase !== rule.phase) fields.push("phase");
    if (fields.length === 0) return { kind: "rule", name, action: "keep" };
    return { kind: "rule", name, action: "update", fields, ...held };
  };
  for (const rule of rules) if (rule.optional !== true) changes.push(ruleChange(rule));
  const wanted = new Set(rules.map((r) => r.ref));
  for (const [ref, found] of existing) {
    if (!wanted.has(ref))
      changes.push({ kind: "rule", name: `${found.phase}/${ref}`, action: "delete" });
  }
  // Last, after every deletion (the Free plan's one rate rule may need its slot freed first).
  for (const rule of rules) if (rule.optional === true) changes.push(ruleChange(rule));
  return { changes, rules, entrypoints, existing, newProofs, proofs, rateRedactions };
}

export const zoneApply: Command = {
  words: ["zone", "apply"],
  summary:
    "apply the zone settings and Fin's zone rules (redirect, WAF, cache, config, rate, transforms)",
  positionals: [],
  flags: [
    {
      name: "allow-shared-zone-settings",
      kind: "boolean",
      description: "also change zone-wide settings on a zone another product shares",
    },
    {
      name: "only",
      kind: "string",
      description: "apply only one half",
      values: ["settings", "rules"],
    },
  ],
  overlay: true,
  mutating: true,
  runbook: "zone-apply.md",
  async run(ctx) {
    const only = flagString(ctx.args, "only");
    const { api, writer } = cloudflare(ctx, Object.keys(ctx.settings.zone.settings));
    const zonePath = await bindZone(ctx, api);
    const changes: Change[] = [];
    if (only !== "rules") changes.push(...(await settingChanges(ctx, api, zonePath)));
    let plan: RulePlan | undefined;
    if (only !== "settings") {
      plan = await rulePlan(ctx, api, zonePath);
      changes.push(...plan.changes);
    }
    if (ctx.settings.zone.watchedOnly.length > 0) {
      ctx.out.info(`watched, not applied here: ${ctx.settings.zone.watchedOnly.join(", ")}`);
    }
    const rw =
      plan !== undefined && plan.newProofs.size > 0 && !ctx.dryRun ? railway(ctx) : undefined;

    /** The one write a setting or rule change sends, from the entrypoints as they stand. */
    const writeFor = (change: Change): Write | undefined => {
      if (change.kind === "setting") {
        return {
          target: { kind: "setting", id: change.name },
          method: "PATCH",
          path: `${zonePath}/settings/${change.name}`,
          body: { value: ctx.settings.zone.settings[change.name] },
        };
      }
      if (plan === undefined || change.kind !== "rule") return undefined;
      const [phaseName, ref = ""] = change.name.split("/");
      const phase = phaseName as Phase;
      const desired = plan.rules.find((r) => r.ref === ref);
      const found = plan.existing.get(ref);
      // Only a write to the rate phase carries a threshold, so only its error is redacted.
      const redact =
        phase === RATE_PHASE || found?.phase === RATE_PHASE ? { redact: plan.rateRedactions } : {};
      if (change.action === "delete" && found !== undefined) {
        const rulesetId = plan.entrypoints.get(found.phase)?.id ?? "";
        return {
          target: { kind: "rule", ref, hosts: [], rulesetId, id: found.rule.id },
          method: "DELETE",
          path: `${zonePath}/rulesets/${rulesetId}/rules/${found.rule.id}`,
          ...redact,
        };
      }
      if (desired === undefined) return undefined;
      if (change.action === "update" && found !== undefined) {
        const rulesetId = plan.entrypoints.get(found.phase)?.id ?? "";
        return {
          target: { kind: "rule", ref, hosts: desired.hosts, rulesetId, id: found.rule.id },
          method: "PATCH",
          path: `${zonePath}/rulesets/${rulesetId}/rules/${found.rule.id}`,
          body: ruleBody(desired),
          ...redact,
        };
      }
      const ruleset = plan.entrypoints.get(phase);
      if (ruleset === undefined) {
        return {
          target: { kind: "ruleset", phase, refs: [ref], hosts: desired.hosts },
          method: "POST",
          path: `${zonePath}/rulesets`,
          body: { name: `fin-next ${phase}`, kind: "zone", phase, rules: [ruleBody(desired)] },
          ...redact,
        };
      }
      return {
        target: { kind: "rule", ref, hosts: desired.hosts, rulesetId: ruleset.id },
        method: "POST",
        path: `${zonePath}/rulesets/${ruleset.id}/rules`,
        body: ruleBody(desired),
        ...redact,
      };
    };

    return ctx.applyPlan(
      "zone",
      changes,
      async (change) => {
        if (change.kind === "variable") {
          if (plan === undefined) return;
          const service = change.name.split(".")[0] ?? "";
          const roles = ctx.settings.ingressProofs[service] ?? [];
          const value: Record<string, string[]> = {};
          for (const role of roles) value[role] = [plan.proofs.get(role)?.reveal() ?? ""];
          const json = new Secret(JSON.stringify(value));
          ctx.masker.register(json.reveal(), "<ingress-proofs>");
          await rw?.setVariables(
            ctx.run,
            ctx.settings,
            service,
            { FIN_INGRESS_PROOFS: json },
            `pnpm fin zone apply: ingress proofs (${ctx.run.id})`,
          );
          return;
        }
        if (plan !== undefined && change.kind === "rule" && change.action === "create") {
          // A phase entrypoint is made only if it still does not exist, checked just before.
          const phase = (change.name.split("/")[0] ?? "") as Phase;
          if (plan.entrypoints.get(phase) === undefined) {
            const now = await api.getOptional<Ruleset>(
              `${zonePath}/rulesets/phases/${phase}/entrypoint`,
            );
            registerRuleset(ctx, phase, now);
            plan.entrypoints.set(phase, now);
          }
        }
        const write = writeFor(change);
        if (write === undefined) return;
        const result = await writer.write<Ruleset>(
          write.target,
          write.method,
          write.path,
          write.body,
          { redact: write.redact ?? [] },
        );
        if (plan !== undefined && change.kind === "rule" && write.method === "POST") {
          const phase = (change.name.split("/")[0] ?? "") as Phase;
          registerRuleset(ctx, phase, result);
          plan.entrypoints.set(phase, result);
        }
      },
      {},
      {
        check: (change) => {
          if (change.kind === "variable") {
            const service = change.name.split(".")[0] ?? "";
            if (ctx.settings.railway.services[service] === undefined) {
              throw new RefusedError(
                `railway: ${service} is not a service the public settings list`,
              );
            }
            return;
          }
          const write = writeFor(change);
          if (write !== undefined) writer.check(write.target, write.method, write.path, write.body);
        },
        after: async () =>
          plan === undefined ? {} : { rulesetHashes: await readRulesetHashes(ctx, api, zonePath) },
      },
    );
  },
};
