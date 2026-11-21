// T-RV-03 and T-RV-04 (spec 07 §3.3, §3.4): roles, their models, and the effort floor.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadCommittedModels, parseReviewOptions, loadCommittedDefaults } from "../src/options.ts";
import type { Effort, ModelName, ReviewOptions } from "../src/options.ts";
import {
  GATING_ROLES,
  RV06_DEFAULT_FLOOR,
  ROLES,
  TIERS,
  checkFloor,
  doctorSessions,
  effortFieldOf,
  floorViolations,
  loadCommittedFloor,
  parseFloorConfig,
  sessionModel,
} from "../src/roles.ts";
import type { Role, Tier } from "../src/roles.ts";
import { cli, copyEngine } from "./helpers/cli.ts";

const models = loadCommittedModels();
const defaults = loadCommittedDefaults(models);
const floor = loadCommittedFloor();
const MODELS: ModelName[] = ["opus", "fable"];
const EFFORTS: Effort[] = ["high", "xhigh", "max"];
const ATTACK_ROLES: Role[] = ["attack", "sceptic2"];
const OVERALL_ROLES: Role[] = ["lens", "joins", "test-truth", "sibling", "sceptic1", "sceptic3", "second-look"];

function validCombinations(): ReviewOptions[] {
  const out: ReviewOptions[] = [];
  for (const model of MODELS)
    for (const effort of EFFORTS)
      for (const attackModel of MODELS)
        for (const attackEffort of EFFORTS) {
          const parsed = parseReviewOptions({ model, effort, attackModel, attackEffort }, "spool", defaults, { models });
          if (parsed.ok) out.push(parsed.value);
        }
  return out;
}

describe("T-RV-03: sessionModel", () => {
  it("lists every role of spec 07 §3.3 once", () => {
    assert.deepEqual([...ROLES].sort(), [...ATTACK_ROLES, ...OVERALL_ROLES, "doctor"].sort());
    assert.equal(new Set(ROLES).size, ROLES.length);
  });

  it("puts attack and sceptic2 on the attack model and effort, every other role on the overall ones", () => {
    const combos = validCombinations();
    assert.equal(combos.length, 27);
    for (const o of combos) {
      for (const role of ATTACK_ROLES) {
        assert.deepEqual(sessionModel(role, o, models), {
          model: o.attackModel,
          modelId: o.attackModel === "opus" ? "claude-opus-5-5" : "claude-fable-5-2",
          effort: o.attackEffort,
        });
      }
      for (const role of OVERALL_ROLES) {
        assert.deepEqual(sessionModel(role, o, models), {
          model: o.model,
          modelId: o.model === "opus" ? "claude-opus-5-5" : "claude-fable-5-2",
          effort: o.effort,
        });
      }
      assert.deepEqual(sessionModel("doctor", o, models), { model: o.model, modelId: sessionModel("lens", o, models).modelId, effort: "high" });
    }
  });

  it("the second sceptic follows the attack model even when it differs from the overall model", () => {
    const o: ReviewOptions = { model: "opus", effort: "max", attackModel: "fable", attackEffort: "high", fast: false };
    assert.equal(sessionModel("sceptic2", o, models).modelId, "claude-fable-5-2");
    assert.equal(sessionModel("sceptic1", o, models).modelId, "claude-opus-5-5");
    assert.equal(sessionModel("sceptic3", o, models).modelId, "claude-opus-5-5");
  });

  it("never returns an ID outside config/models.json, and reads the committed IDs by default", () => {
    const ids = new Set([models.opus, models.fable]);
    for (const o of validCombinations()) for (const role of ROLES) assert.ok(ids.has(sessionModel(role, o).modelId));
  });

  it("the switch is exhaustive: an unknown role throws rather than falling through", () => {
    assert.throws(() => sessionModel("bookkeeper" as Role, defaults, models), TypeError);
    assert.throws(() => effortFieldOf("bookkeeper" as Role), TypeError);
  });

  it("the doctor checks each allowed model at high", () => {
    assert.deepEqual(doctorSessions(models), [
      { model: "opus", modelId: "claude-opus-5-5", effort: "high" },
      { model: "fable", modelId: "claude-fable-5-2", effort: "high" },
    ]);
  });

  it("effortFieldOf agrees with sessionModel for every role", () => {
    const o: ReviewOptions = { model: "opus", effort: "max", attackModel: "fable", attackEffort: "xhigh", fast: false };
    for (const role of ROLES) {
      const field = effortFieldOf(role);
      if (field === null) assert.equal(role, "doctor");
      else assert.equal(sessionModel(role, o, models).effort, o[field]);
    }
  });
});

describe("T-RV-04: the effort floor", () => {
  it("config/floor.json holds [RV-06]'s default", () => {
    assert.deepEqual(JSON.parse(JSON.stringify(floor)), JSON.parse(JSON.stringify(RV06_DEFAULT_FLOOR)));
  });

  it("checkFloor over every tier, role and effort", () => {
    const expectedMinimum = (tier: Tier, role: Role): Effort =>
      tier === "S" && OVERALL_ROLES.includes(role) ? "xhigh" : "high";
    let refused = 0;
    for (const tier of TIERS) {
      for (const role of ROLES) {
        for (const effort of EFFORTS) {
          const result = checkFloor(tier, role, effort, floor);
          const minimum = expectedMinimum(tier, role);
          const ok = EFFORTS.indexOf(effort) >= EFFORTS.indexOf(minimum);
          assert.equal(result.ok, ok, `${tier} ${role} ${effort}`);
          assert.equal(result.minimum, minimum);
          if (!result.ok) {
            refused++;
            assert.equal(result.code, "floor_tier_s");
            assert.equal(result.message, `On tier S the ${role} role needs effort xhigh or above, not high ([RV-06]).`);
          }
        }
      }
    }
    assert.equal(refused, OVERALL_ROLES.length, "only high on tier S for the overall roles is refused");
  });

  it("reads the committed floor by default and refuses unknown arguments", () => {
    assert.equal(checkFloor("S", "lens", "high").ok, false);
    assert.equal(checkFloor("S", "attack", "high").ok, true);
    assert.throws(() => checkFloor("X" as Tier, "lens", "high", floor), TypeError);
    assert.throws(() => checkFloor("S", "nobody" as Role, "high", floor), TypeError);
    assert.throws(() => checkFloor("S", "lens", "low" as Effort, floor), TypeError);
  });

  it("floorViolations: --effort high on tier S breaks the floor for every overall role, and nothing else does", () => {
    for (const o of validCombinations()) {
      for (const tier of TIERS) {
        const violations = floorViolations(tier, o, floor, models);
        if (tier === "S" && o.effort === "high") {
          assert.equal(violations.length, 1);
          const [violation] = violations;
          assert.equal(violation?.code, "floor_tier_s");
          assert.equal(violation?.field, "effort");
          assert.equal(violation?.minimum, "xhigh");
          assert.deepEqual(violation?.roles, OVERALL_ROLES);
        } else {
          assert.deepEqual(violations, [], `${tier} ${JSON.stringify(o)}`);
        }
      }
    }
    assert.ok(!GATING_ROLES.includes("doctor"));
  });

  it("a stricter floor (xhigh everywhere) also catches the attack effort", () => {
    const strict = parseFloorConfig({
      version: 1,
      tiers: Object.fromEntries(TIERS.map((tier) => [tier, Object.fromEntries(ROLES.map((role) => [role, "xhigh"]))])),
    });
    assert.equal(strict.ok, true);
    if (!strict.ok) return;
    const violations = floorViolations("N", { ...defaults, effort: "high" }, strict.value, models);
    assert.deepEqual(violations.map((violation) => [violation.code, violation.field]), [
      ["floor_tier_n", "effort"],
      ["floor_tier_n", "attackEffort"],
    ]);
  });

  it("the CLI refuses --effort high for a tier S gating run with exit 64 and floor_tier_s", async () => {
    const refused = await cli(["options", "--tier", "S", "--effort", "high"]);
    assert.equal(refused.code, 64);
    assert.equal(refused.stdout, "");
    assert.equal(
      refused.stderr,
      "fin-review: refused: floor_tier_s: --effort high is below the tier S floor of xhigh for lens, joins, test-truth, sibling, sceptic1, sceptic3, second-look ([RV-06]); a gating run is refused, and an --advisory run goes ahead with no receipt.\n",
    );
    for (const tier of ["N", "D"]) {
      const allowed = await cli(["options", `--tier=${tier}`, "--effort=high"]);
      assert.equal(allowed.code, 0, allowed.stderr);
      assert.deepEqual(JSON.parse(allowed.stdout).floor, { tier, advisory: false, violations: [] });
    }
    const attackHigh = await cli(["options", "--tier", "S", "--attack-effort", "high"]);
    assert.equal(attackHigh.code, 0, attackHigh.stderr);
  });

  it("--advisory goes ahead, reports the breach and says it is not a gate receipt", async () => {
    const run = await cli(["options", "--tier", "S", "--effort", "high", "--advisory"]);
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "advisory: not a gate receipt\n");
    const floorOut = JSON.parse(run.stdout).floor;
    assert.equal(floorOut.advisory, true);
    assert.equal(floorOut.violations[0].code, "floor_tier_s");
    const lonely = await cli(["options", "--advisory"]);
    assert.equal(lonely.code, 64);
    assert.match(lonely.stderr, /^fin-review: refused: missing_option: --advisory needs --tier\./);
    const badTier = await cli(["options", "--tier", "s"]);
    assert.equal(badTier.code, 64);
    assert.match(badTier.stderr, /^fin-review: refused: invalid_value: /);
  });

  it("parseFloorConfig refuses a missing role or tier, an unknown key and an effort below high", () => {
    const good = JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", "floor.json"), "utf8")) as Record<string, unknown>;
    assert.equal(parseFloorConfig(good).ok, true);
    const tiers = good["tiers"] as Record<string, Record<string, string>>;
    const variants: unknown[] = [
      null,
      { ...good, version: 2 },
      { ...good, extra: true },
      { ...good, tiers: { S: tiers["S"], N: tiers["N"] } },
      { ...good, tiers: { ...tiers, X: tiers["S"] } },
      { ...good, tiers: { ...tiers, S: { ...tiers["S"], lens: "medium" } } },
      { ...good, tiers: { ...tiers, S: { ...tiers["S"], auditor: "high" } } },
      { ...good, tiers: { ...tiers, N: Object.fromEntries(Object.entries(tiers["N"] ?? {}).filter(([role]) => role !== "attack")) } },
    ];
    for (const variant of variants) assert.equal(parseFloorConfig(variant).ok, false, JSON.stringify(variant));
  });

  it("an invalid floor.json makes every command exit 78", async () => {
    const engine = copyEngine();
    try {
      writeFileSync(join(engine.configDir, "floor.json"), JSON.stringify({ version: 1, tiers: {} }));
      for (const command of ["options", "plan", "help"]) {
        const run = await cli([command], { configDir: engine.configDir });
        assert.equal(run.code, 78, command);
        assert.match(run.stderr, /^fin-review: config: floor\.json: /);
      }
    } finally {
      engine.cleanup();
    }
  });
});
