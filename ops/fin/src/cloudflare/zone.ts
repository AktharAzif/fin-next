// `pnpm fin zone apply <env>`: the zone settings and Fin's zone rules (spec 01 §7.6, ARCHITECTURE
// §5.6 to §5.8 and §5.11, BD-11, BD-12, BD-13).
//
// Settings: each setting in the public settings is compared with the zone's; on a zone another
// product shares (`zone.shared`), a zone-wide setting is held unless the run passes
// --allow-shared-zone-settings, because it changes that product's hosts too.
//
// Rules: each phase's entrypoint is read; only rules whose ref starts with `fin_next_` are compared,
// created, updated or deleted, each through the per-rule endpoints. A phase entrypoint is created
// only when it does not exist (checked again just before). Ingress proofs keep their current values;
// a host with no proof gets a new one (32 random bytes, base64url), which is set sealed on the
// services that check it before the rule that sends it is written (spec 01 §7.6's order).

import { createHash } from "node:crypto";
import type { Command } from "../command.ts";
import { flagBool, flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { type HostRole, hostOf } from "../core/overlay.ts";
import { type Change, canonical, differingFields } from "../core/plan.ts";
import { Secret } from "../core/secret.ts";
import { cloudflare, railway } from "./common.ts";
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

/** A stable hash of Fin's rules in one phase, for the run record and the watcher. */
export function ruleSetHash(rules: readonly DesiredRule[]): string {
  const sorted = [...rules]
    .sort((a, b) => a.ref.localeCompare(b.ref))
    .map((r) => canonical(ruleBody(r)));
  return createHash("sha256").update(sorted.join("\n")).digest("hex");
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
    for (const rule of ruleset?.rules ?? []) {
      if (rule.ref?.startsWith("fin_next_")) existing.set(rule.ref, { phase, rule });
    }
  }

  const proofRoles: HostRole[] = [s.hostRoles.api, ...s.hostRoles.apiPaths];
  const proofs = new Map<HostRole, Secret>();
  const newProofs = new Set<HostRole>();
  for (const role of proofRoles) {
    const current = existingProof(existing.get(`fin_next_ingress_proof_${role}`)?.rule);
    const secret = current === undefined ? newProof(ctx) : new Secret(current);
    ctx.masker.register(secret.reveal(), `<ingress-proof:${role}>`);
    proofs.set(role, secret);
    if (current === undefined) newProofs.add(role);
  }

  const threshold = ctx.overlay.thresholds[s.rules.rate.threshold];
  const pair = (role: HostRole) => ({ role, host: hostOf(ctx.overlay, role) });
  const rules = desiredRules({
    hosts: {
      browser: s.hostRoles.browser.map(pair),
      apiPaths: s.hostRoles.apiPaths.map(pair),
      api: hostOf(ctx.overlay, s.hostRoles.api),
    },
    proofs,
    rate: {
      pathPrefix: s.rules.rate.pathPrefix,
      periodSeconds: s.rules.rate.periodSeconds,
      mitigationTimeoutSeconds: s.rules.rate.mitigationTimeoutSeconds,
      ...(threshold === undefined ? {} : { threshold }),
    },
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
  const wanted = new Set(rules.map((r) => r.ref));
  for (const rule of rules) {
    const found = existing.get(rule.ref);
    const name = `${rule.phase}/${rule.ref}`;
    if (found === undefined) {
      changes.push({
        kind: "rule",
        name,
        action: "create",
        ...(rule.held === undefined ? {} : { held: rule.held }),
      });
      continue;
    }
    const fields = differingFields(comparable(found.rule), comparable({ ...ruleBody(rule) }));
    if (found.phase !== rule.phase) fields.push("phase");
    if (fields.length === 0) changes.push({ kind: "rule", name, action: "keep" });
    else
      changes.push({
        kind: "rule",
        name,
        action: "update",
        fields,
        ...(rule.held === undefined ? {} : { held: rule.held }),
      });
  }
  for (const [ref, found] of existing) {
    if (!wanted.has(ref))
      changes.push({ kind: "rule", name: `${found.phase}/${ref}`, action: "delete" });
  }
  return { changes, rules, entrypoints, existing, newProofs, proofs };
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
    const { api, writer, zonePath } = cloudflare(ctx, Object.keys(ctx.settings.zone.settings));
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
    const hashes: Record<string, string> = {};
    if (plan !== undefined) {
      for (const phase of PHASES) {
        const inPhase = plan.rules.filter((r) => r.phase === phase && r.held === undefined);
        if (inPhase.length > 0) hashes[phase] = ruleSetHash(inPhase);
      }
    }
    return ctx.applyPlan(
      "zone",
      changes,
      async (change) => {
        if (change.kind === "setting") {
          const value = ctx.settings.zone.settings[change.name];
          await writer.write(
            { kind: "setting", id: change.name },
            "PATCH",
            `${zonePath}/settings/${change.name}`,
            { value },
          );
          return;
        }
        if (plan === undefined) return;
        if (change.kind === "variable") {
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
        const ref = change.name.split("/")[1] ?? "";
        const phase = change.name.split("/")[0] as Phase;
        const desired = plan.rules.find((r) => r.ref === ref);
        const found = plan.existing.get(ref);
        if (change.action === "delete" && found !== undefined) {
          const rulesetId = plan.entrypoints.get(found.phase)?.id ?? "";
          await writer.write(
            { kind: "rule", ref, hosts: [] },
            "DELETE",
            `${zonePath}/rulesets/${rulesetId}/rules/${found.rule.id}`,
          );
          return;
        }
        if (desired === undefined) return;
        if (change.action === "update" && found !== undefined) {
          const rulesetId = plan.entrypoints.get(found.phase)?.id ?? "";
          await writer.write(
            { kind: "rule", ref, hosts: desired.hosts },
            "PATCH",
            `${zonePath}/rulesets/${rulesetId}/rules/${found.rule.id}`,
            ruleBody(desired),
          );
          return;
        }
        // create: into the phase entrypoint, made only if it still does not exist.
        let ruleset = plan.entrypoints.get(phase);
        ruleset ??= await api.getOptional<Ruleset>(
          `${zonePath}/rulesets/phases/${phase}/entrypoint`,
        );
        if (ruleset === undefined) {
          const created = await writer.write<Ruleset>(
            { kind: "ruleset", phase, refs: [ref], hosts: desired.hosts },
            "POST",
            `${zonePath}/rulesets`,
            { name: `fin-next ${phase}`, kind: "zone", phase, rules: [ruleBody(desired)] },
          );
          plan.entrypoints.set(phase, created);
          return;
        }
        const updated = await writer.write<Ruleset>(
          { kind: "rule", ref, hosts: desired.hosts },
          "POST",
          `${zonePath}/rulesets/${ruleset.id}/rules`,
          ruleBody(desired),
        );
        plan.entrypoints.set(phase, updated);
      },
      { ruleHashes: hashes },
    );
  },
};
