// The zone's settings and rule sets (spec 01 §7.6, §7.11): the settings as listed, and in each
// phase `rules apply` writes, the hash of fin-next's own rules (ref `fin_next_`, BD-11) equal to
// the last registered run's. The shared zone also holds the old product's rules (FD-09): they are
// left out of the hash, so their changes neither raise fin-next's alert nor mask a change to
// fin-next's, unless one of them names a fin-next host.
import { finRulesetHash, isFinRule } from "../hash.ts";
import { type Check, type Failure, isRecord, records } from "./common.ts";

/** Whether `actual` holds every key of `expected` with the same value (objects compared deeply). */
export function matches(expected: unknown, actual: unknown): boolean {
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([k, v]) => matches(v, actual[k]));
  }
  return expected === actual;
}

export const zone: Check = {
  name: "zone",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const [settings, universal, bots] = await Promise.all([
      ctx.cf.get(`/zones/${zoneId}/settings`),
      ctx.cf.get(`/zones/${zoneId}/ssl/universal/settings`),
      ctx.cf.get(`/zones/${zoneId}/bot_management`),
    ]);
    const byId = new Map(records(settings).map((s) => [String(s.id), s.value]));
    for (const [id, expected] of Object.entries(ctx.settings.zoneSettings)) {
      if (!byId.has(id)) failures.push({ check: "zone", target: id, detail: "setting_missing" });
      else if (!matches(expected, byId.get(id))) {
        failures.push({ check: "zone", target: id, detail: "setting_mismatch" });
      }
    }
    if (!isRecord(universal) || universal.enabled !== ctx.settings.universalSsl) {
      failures.push({ check: "zone", target: "universal_ssl", detail: "universal_ssl_off" });
    }
    if (!isRecord(bots) || bots.fight_mode !== ctx.settings.botFightMode) {
      failures.push({ check: "zone", target: "bot_fight_mode", detail: "bot_fight_on" });
    }
    return failures;
  },
};

const rulesOf = (ruleset: unknown): unknown[] =>
  isRecord(ruleset) && Array.isArray(ruleset.rules) ? ruleset.rules : [];

/** Whether `text` names `host` or a name under it (not merely a longer name ending with it). */
export function namesHost(text: string, host: string): boolean {
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`).test(text.toLowerCase());
}

export const rules: Check = {
  name: "rules",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const hosts = Object.values(ctx.settings.hosts);
    // A rule of another product that names a fin-next host acts on fin-next's traffic from
    // outside fin-next's namespace (a skip or a redirect ahead of fin-next's rules, say).
    const foreign = (list: readonly unknown[]) =>
      list.some(
        (rule) =>
          !isFinRule(rule) &&
          isRecord(rule) &&
          typeof rule.expression === "string" &&
          hosts.some((host) => namesHost(rule.expression as string, host)),
      );
    // Every phase `rules apply` writes, and every phase a registered run hashed.
    const phases = [
      ...new Set([...ctx.settings.rulesetPhases, ...Object.keys(ctx.settings.rulesetHashes)]),
    ];
    for (const phase of phases) {
      const add = (detail: string) => failures.push({ check: "rules", target: phase, detail });
      const list = rulesOf(
        await ctx.cf.get(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`),
      );
      const want = ctx.settings.rulesetHashes[phase];
      if (want === undefined) add("hash_unset");
      else if ((await finRulesetHash(list)) !== want) add("ruleset_hash_mismatch");
      if (foreign(list)) add("foreign_rule");
    }
    // Any other zone rule set: the old product's are its own, unless one holds a fin_next_ rule
    // (written where no registered run hashes it) or names a fin-next host.
    const checked = new Set(phases);
    // The rule sets list pages by cursor alone (Cloudflare's API reference).
    const all = await ctx.cf.list(`/zones/${zoneId}/rulesets`, {}, "cursor");
    for (const ruleset of records(all)) {
      if (ruleset.kind !== "zone" || typeof ruleset.phase !== "string") continue;
      if (checked.has(ruleset.phase) || typeof ruleset.id !== "string") continue;
      const add = (detail: string) =>
        failures.push({ check: "rules", target: String(ruleset.phase), detail });
      const list = rulesOf(
        await ctx.cf.get(`/zones/${zoneId}/rulesets/${encodeURIComponent(ruleset.id)}`),
      );
      if (list.some(isFinRule)) add("ruleset_unexpected");
      if (foreign(list)) add("foreign_rule");
    }
    return failures;
  },
};
