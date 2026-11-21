// The zone's settings and rule sets (spec 01 §7.6): the settings as listed, and each rule set's
// hash equal to the last registered `pnpm fin rules apply`.
import { rulesetHash } from "../hash.ts";
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

export const rules: Check = {
  name: "rules",
  async run(ctx) {
    const failures: Failure[] = [];
    const zoneId = await ctx.zoneId();
    const expected = new Set(ctx.settings.rulesetPhases);
    for (const phase of ctx.settings.rulesetPhases) {
      const entry = await ctx.cf.get(`/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
      const list = isRecord(entry) && Array.isArray(entry.rules) ? entry.rules : [];
      const want = ctx.settings.rulesetHashes[phase];
      if (want === undefined) {
        failures.push({ check: "rules", target: phase, detail: "hash_unset" });
      } else if ((await rulesetHash(list)) !== want) {
        failures.push({ check: "rules", target: phase, detail: "ruleset_hash_mismatch" });
      }
    }
    for (const ruleset of records(await ctx.cf.list(`/zones/${zoneId}/rulesets`))) {
      if (ruleset.kind !== "zone" || typeof ruleset.phase !== "string") continue;
      if (!expected.has(ruleset.phase)) {
        failures.push({ check: "rules", target: ruleset.phase, detail: "ruleset_unexpected" });
      }
    }
    return failures;
  },
};
