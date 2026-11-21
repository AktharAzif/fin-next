// T-RV-01, T-RV-02 and T-RV-05 (spec 07 §3.2, §3.5, §3.6): the R11 validator at every entry point.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadEngineConfig } from "../src/config.ts";
import {
  FABLE_OVERALL_OPUS_ATTACK_MESSAGE,
  displayValue,
  loadCommittedDefaults,
  loadCommittedModels,
  parseCiInputOptions,
  parseDefaultsConfig,
  parseMachineOptions,
  parseModelsConfig,
  parseReviewOptions,
} from "../src/options.ts";
import type { Effort, ModelName, OptionError, OptionSource, ParseResult, ReviewOptions } from "../src/options.ts";
import { cli, copyEngine, spawnCli } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git-fixture.ts";

const MODELS: ModelName[] = ["opus", "fable"];
const EFFORTS: Effort[] = ["high", "xhigh", "max"];
const models = loadCommittedModels();
const defaults = loadCommittedDefaults(models);
const REFUSAL_LINE = `fin-review: refused: fable_overall_opus_attack: ${FABLE_OVERALL_OPUS_ATTACK_MESSAGE}\n`;

interface Combination {
  model: ModelName;
  effort: Effort;
  attackModel: ModelName;
  attackEffort: Effort;
  valid: boolean;
}

function combinations(): Combination[] {
  const out: Combination[] = [];
  for (const model of MODELS)
    for (const effort of EFFORTS)
      for (const attackModel of MODELS)
        for (const attackEffort of EFFORTS) {
          out.push({ model, effort, attackModel, attackEffort, valid: !(model === "fable" && attackModel === "opus") });
        }
  return out;
}

const COMBINATIONS = combinations();

function expectedOptions(c: Combination, fast = false): ReviewOptions {
  return { model: c.model, effort: c.effort, attackModel: c.attackModel, attackEffort: c.attackEffort, fast };
}

function assertOutcome(result: ParseResult, c: Combination, where: string): void {
  if (c.valid) {
    assert.equal(result.ok, true, `${where}: ${JSON.stringify(c)} should be accepted`);
    if (result.ok) assert.deepEqual({ ...result.value }, expectedOptions(c), where);
    return;
  }
  assert.equal(result.ok, false, `${where}: ${JSON.stringify(c)} should be refused`);
  if (!result.ok) {
    assert.deepEqual(
      result.errors,
      [{ code: "fable_overall_opus_attack", field: "attackModel", value: "opus", message: FABLE_OVERALL_OPUS_ATTACK_MESSAGE }],
      where,
    );
  }
}

function codes(result: ParseResult): string[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

describe("T-RV-01: all 36 combinations at every entry point", () => {
  it("enumerates 36 combinations, 27 valid and 9 Fable-overall-Opus-attack", () => {
    assert.equal(COMBINATIONS.length, 36);
    assert.equal(COMBINATIONS.filter((c) => c.valid).length, 27);
    const refused = COMBINATIONS.filter((c) => !c.valid);
    assert.equal(refused.length, 9);
    assert.ok(refused.every((c) => c.model === "fable" && c.attackModel === "opus"));
  });

  for (const source of ["cli", "config", "spool", "receipt"] as OptionSource[]) {
    it(`the validator, source ${source}`, () => {
      let accepted = 0;
      for (const c of COMBINATIONS) {
        const input = { model: c.model, effort: c.effort, attackModel: c.attackModel, attackEffort: c.attackEffort, fast: false };
        const result = parseReviewOptions(input, source, defaults, { models });
        assertOutcome(result, c, source);
        if (result.ok) accepted++;
      }
      assert.equal(accepted, 27);
    });
  }

  it("CI inputs, as the strings review.yml passes through env", () => {
    let accepted = 0;
    for (const c of COMBINATIONS) {
      const inputs = { model: c.model, effort: c.effort, "attack-model": c.attackModel, "attack-effort": c.attackEffort, fast: "false" };
      const result = parseCiInputOptions(inputs, defaults, { models });
      assertOutcome(result, c, "ci-input");
      if (result.ok) accepted++;
    }
    assert.equal(accepted, 27);
  });

  for (const form of ["--x v", "--x=v"] as const) {
    it(`the CLI in the "${form}" form`, async () => {
      let accepted = 0;
      for (const c of COMBINATIONS) {
        const pairs: Array<[string, string]> = [
          ["--model", c.model],
          ["--effort", c.effort],
          ["--attack-model", c.attackModel],
          ["--attack-effort", c.attackEffort],
        ];
        const argv = ["options", ...pairs.flatMap(([flag, value]) => (form === "--x v" ? [flag, value] : [`${flag}=${value}`]))];
        const run = await cli(argv);
        if (c.valid) {
          assert.equal(run.code, 0, `${argv.join(" ")}: ${run.stderr}`);
          assert.deepEqual(JSON.parse(run.stdout).options, expectedOptions(c));
          assert.equal(run.stderr, "");
          accepted++;
        } else {
          assert.equal(run.code, 64, argv.join(" "));
          assert.equal(run.stdout, "");
          assert.equal(run.stderr, REFUSAL_LINE);
        }
      }
      assert.equal(accepted, 27);
    });
  }

  it("the CLI as a real process, for one valid and one refused combination", () => {
    const valid = spawnCli(["options", "--model", "opus", "--effort=max", "--attack-model", "fable", "--attack-effort=xhigh"]);
    assert.equal(valid.code, 0, valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout).options, { model: "opus", effort: "max", attackModel: "fable", attackEffort: "xhigh", fast: false });
    const refused = spawnCli(["options", "--model=fable", "--attack-model", "opus"]);
    assert.equal(refused.code, 64);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, REFUSAL_LINE);
  });

  describe("the configuration files", () => {
    let engine: ReturnType<typeof copyEngine>;
    let home: ReturnType<typeof tempDir>;
    before(() => {
      engine = copyEngine();
      home = tempDir("home");
    });
    after(() => {
      engine.cleanup();
      home.cleanup();
    });

    it("config/defaults.json: valid combinations load, the 9 make every command exit 78", async () => {
      let accepted = 0;
      for (const c of COMBINATIONS) {
        writeFileSync(join(engine.configDir, "defaults.json"), JSON.stringify(expectedOptions(c)));
        const loaded = loadEngineConfig(engine.configDir);
        const run = await cli(["options"], { configDir: engine.configDir });
        if (c.valid) {
          assert.equal(loaded.ok, true);
          if (loaded.ok) assert.deepEqual({ ...loaded.value.defaults }, expectedOptions(c));
          assert.equal(run.code, 0, run.stderr);
          assert.deepEqual(JSON.parse(run.stdout).options, expectedOptions(c));
          accepted++;
        } else {
          assert.equal(loaded.ok, false);
          if (!loaded.ok) {
            assert.deepEqual(loaded.problems, [{ file: "defaults.json", message: `fable_overall_opus_attack: ${FABLE_OVERALL_OPUS_ATTACK_MESSAGE}` }]);
          }
          assert.equal(run.code, 78);
          assert.equal(run.stderr, `fin-review: config: defaults.json: fable_overall_opus_attack: ${FABLE_OVERALL_OPUS_ATTACK_MESSAGE}\n`);
        }
      }
      assert.equal(accepted, 27);
      writeFileSync(join(engine.configDir, "defaults.json"), JSON.stringify(defaults));
    });

    it("$FIN_REVIEW_HOME/config.json options: valid combinations resolve, the 9 exit 78", async () => {
      mkdirSync(home.dir, { recursive: true });
      let accepted = 0;
      for (const c of COMBINATIONS) {
        writeFileSync(join(home.dir, "config.json"), JSON.stringify({ claudePath: "/opt/claude", options: expectedOptions(c) }));
        const run = await cli(["options"], { env: { FIN_REVIEW_HOME: home.dir } });
        if (c.valid) {
          assert.equal(run.code, 0, run.stderr);
          assert.deepEqual(JSON.parse(run.stdout).options, expectedOptions(c));
          accepted++;
        } else {
          assert.equal(run.code, 78);
          assert.equal(
            run.stderr,
            `fin-review: config: $FIN_REVIEW_HOME/config.json: fable_overall_opus_attack: ${FABLE_OVERALL_OPUS_ATTACK_MESSAGE}\n`,
          );
        }
      }
      assert.equal(accepted, 27);
    });
  });
});

// ---- T-RV-02 ------------------------------------------------------------------------------------

const EFFORT_REFUSALS: Array<[string, string]> = [
  ["low", "effort_below_high"],
  ["medium", "effort_below_high"],
  ["ultracode", "effort_not_allowed"],
  ["auto", "effort_not_allowed"],
  ["none", "effort_not_allowed"],
  ["minimal", "effort_not_allowed"],
  ["5", "effort_unknown"],
  ["0", "effort_unknown"],
  ["-1", "effort_unknown"],
  ["1e3", "effort_unknown"],
  ["XHIGH", "effort_unknown"],
  ["High", "effort_unknown"],
  ["MAX", "effort_unknown"],
  [" high", "effort_unknown"],
  ["high ", "effort_unknown"],
  ["high\n", "effort_unknown"],
  ["hіgh", "effort_unknown"], // Cyrillic і
  ["xhigh​", "effort_unknown"], // zero-width space
  ["highest", "effort_unknown"],
  ["", "effort_unknown"],
];

const MODEL_REFUSALS: Array<[string, string]> = [
  ["sonnet", "model_not_allowed"],
  ["haiku", "model_not_allowed"],
  ["opusplan", "model_not_allowed"],
  ["default", "model_not_allowed"],
  ["best", "model_not_allowed"],
  ["auto", "model_not_allowed"],
  ["claude-opus-5-5", "bare_model_id"],
  ["claude-fable-5-2", "bare_model_id"],
  ["claude-sonnet-4-6", "bare_model_id"],
  ["claude-", "bare_model_id"],
  ["anthropic/claude-opus-5-5", "bare_model_id"],
  ["us.anthropic.claude-opus-5-5", "bare_model_id"],
  ["opus[1m]", "bare_model_id"],
  ["opus:latest", "bare_model_id"],
  ["fable.2", "bare_model_id"],
  ["Opus", "model_unknown"],
  ["OPUS", "model_unknown"],
  ["Fable", "model_unknown"],
  ["Sonnet", "model_unknown"],
  [" opus", "model_unknown"],
  ["opus ", "model_unknown"],
  ["fable\t", "model_unknown"],
  ["оpus", "model_unknown"], // Cyrillic о
  ["opus​", "model_unknown"],
  ["ｏｐｕｓ", "model_unknown"], // full-width
  ["gpt-5", "model_unknown"],
  ["", "model_unknown"],
];

const ALL_SOURCES: OptionSource[] = ["cli", "config", "ci-input", "spool", "receipt"];

/** Parses one field's value through `source`, with the other fields at their defaults. */
function parseOne(source: OptionSource, field: "model" | "effort" | "attackModel" | "attackEffort", value: unknown): ParseResult {
  const full: Record<string, unknown> = { ...defaults, [field]: value };
  if (source === "ci-input") {
    const ciName = field === "attackModel" ? "attack-model" : field === "attackEffort" ? "attack-effort" : field;
    return parseCiInputOptions({ [ciName]: value }, defaults, { models });
  }
  return parseReviewOptions(source === "receipt" ? full : { [field]: value }, source, defaults, { models });
}

describe("T-RV-02: refused values at every source", () => {
  for (const source of ALL_SOURCES) {
    it(`efforts below high, not allowed and unknown (${source})`, () => {
      for (const field of ["effort", "attackEffort"] as const) {
        for (const [value, code] of EFFORT_REFUSALS) {
          if (source === "ci-input" && value === "") continue; // an empty CI input is "not given"
          const result = parseOne(source, field, value);
          assert.deepEqual(codes(result), [code], `${source} ${field}=${JSON.stringify(value)}`);
          if (!result.ok) assert.equal(result.errors[0]?.field, field);
        }
      }
    });

    it(`models outside opus and fable, bare IDs and look-alikes (${source})`, () => {
      for (const field of ["model", "attackModel"] as const) {
        for (const [value, code] of MODEL_REFUSALS) {
          if (source === "ci-input" && value === "") continue;
          const result = parseOne(source, field, value);
          assert.deepEqual(codes(result), [code], `${source} ${field}=${JSON.stringify(value)}`);
        }
      }
    });
  }

  it("an empty CI input is an input not given, and takes the default", () => {
    const result = parseCiInputOptions({ model: "", effort: "", "attack-model": "", "attack-effort": "", fast: "" }, defaults, { models });
    assert.deepEqual(result, { ok: true, value: defaults });
  });

  for (const source of ["config", "spool", "receipt"] as OptionSource[]) {
    it(`wrong types: numbers, booleans, null, arrays and objects (${source})`, () => {
      for (const value of [5, 0, true, null, ["opus"], { name: "opus" }]) {
        for (const field of ["model", "effort", "attackModel", "attackEffort"] as const) {
          assert.deepEqual(codes(parseOne(source, field, value)), ["wrong_type"], `${source} ${field}=${JSON.stringify(value)}`);
        }
      }
      for (const value of ["true", "false", 1, 0, null, "yes"]) {
        const input: Record<string, unknown> = source === "receipt" ? { ...defaults, fast: value } : { fast: value };
        assert.deepEqual(codes(parseReviewOptions(input, source, defaults, { models })), ["wrong_type"], `fast=${JSON.stringify(value)}`);
      }
    });
  }

  it("wrong types in CI inputs: non-strings, and fast other than true or false", () => {
    assert.deepEqual(codes(parseCiInputOptions({ effort: 5 }, defaults, { models })), ["wrong_type"]);
    assert.deepEqual(codes(parseCiInputOptions({ model: true }, defaults, { models })), ["wrong_type"]);
    for (const fast of ["yes", "TRUE", "1", " true", true, 1]) {
      assert.deepEqual(codes(parseCiInputOptions({ fast }, defaults, { models })), ["wrong_type"], `fast=${JSON.stringify(fast)}`);
    }
    assert.deepEqual(parseCiInputOptions({ fast: "true" }, defaults, { models }), { ok: true, value: { ...defaults, fast: true } });
  });

  it("unknown, look-alike, padded and prototype keys are refused, never normalised", () => {
    const keys = [
      "Model",
      "MODEL",
      "models",
      "attack_model",
      "attack-model",
      "attackmodel",
      " model",
      "model ",
      "mоdel",
      "effort​",
      "__proto__",
      "constructor",
      "prototype",
      "toString",
      "hasOwnProperty",
      "",
    ];
    for (const source of ["config", "spool", "receipt"] as OptionSource[]) {
      for (const key of keys) {
        const input = Object.create(null) as Record<string, unknown>;
        if (source === "receipt") Object.assign(input, defaults);
        Object.defineProperty(input, key, { value: "opus", enumerable: true });
        const result = parseReviewOptions(input, source, defaults, { models });
        assert.deepEqual(codes(result), ["unknown_option"], `${source} key ${JSON.stringify(key)}`);
      }
    }
    for (const key of keys.filter((k) => k !== "attack-model")) {
      assert.deepEqual(codes(parseCiInputOptions({ [key]: "opus" }, defaults, { models })), ["unknown_option"], `ci-input ${JSON.stringify(key)}`);
    }
    assert.deepEqual(codes(parseCiInputOptions({ attackModel: "fable" }, defaults, { models })), ["unknown_option"]);
  });

  it("a __proto__ key from JSON text stays an own key and is refused", () => {
    const fromJson = JSON.parse('{"__proto__": {"model": "fable"}, "effort": "max"}') as Record<string, unknown>;
    assert.deepEqual(codes(parseReviewOptions(fromJson, "spool", defaults, { models })), ["unknown_option"]);
    assert.equal(({} as Record<string, unknown>)["model"], undefined);
  });

  it("inherited keys are refused and never read", () => {
    const input = Object.create({ model: "fable", attackModel: "opus" }) as Record<string, unknown>;
    const result = parseReviewOptions(input, "spool", defaults, { models });
    assert.deepEqual(codes(result), ["unknown_option", "unknown_option"]);
  });

  it("accessors and symbol keys are refused", () => {
    let reads = 0;
    const input = {};
    Object.defineProperty(input, "model", {
      enumerable: true,
      get() {
        reads++;
        return "opus";
      },
    });
    assert.deepEqual(codes(parseReviewOptions(input, "config", defaults, { models })), ["wrong_type"]);
    assert.equal(reads, 0);
    const withSymbol = { [Symbol("model")]: "opus" } as unknown as Record<string, unknown>;
    assert.deepEqual(codes(parseReviewOptions(withSymbol, "config", defaults, { models })), ["unknown_option"]);
  });

  it("inputs that are not objects are wrong_type", () => {
    for (const input of [null, ["opus"], "opus", 5, true, undefined]) {
      const result = parseReviewOptions(input as unknown as Record<string, unknown>, "spool", defaults, { models });
      assert.deepEqual(codes(result), ["wrong_type"], JSON.stringify(input));
      if (!result.ok) assert.equal(result.errors[0]?.field, "*");
    }
  });

  it("a receipt must record every option", () => {
    const result = parseReviewOptions({ model: "opus" }, "receipt", defaults, { models });
    assert.deepEqual(codes(result), ["wrong_type", "wrong_type", "wrong_type", "wrong_type"]);
    if (!result.ok) assert.deepEqual(result.errors.map((error) => error.field), ["effort", "attackModel", "attackEffort", "fast"]);
    assert.equal(parseReviewOptions({}, "spool", defaults, { models }).ok, true);
  });

  it("collects every error, in the order of the rules", () => {
    const result = parseReviewOptions(
      { colour: "red", model: "fable", effort: "low", attackModel: "opus", attackEffort: 5, fast: "yes" },
      "spool",
      defaults,
      { models },
    );
    assert.deepEqual(codes(result), ["unknown_option", "wrong_type", "wrong_type", "effort_below_high", "fable_overall_opus_attack"]);
    const many = parseReviewOptions({ model: "sonnet", effort: "ultracode", attackModel: "claude-opus-5-5", attackEffort: "XHIGH" }, "spool", defaults, { models });
    assert.deepEqual(codes(many), ["model_not_allowed", "bare_model_id", "effort_not_allowed", "effort_unknown"]);
  });

  it("rule 5 uses the resolved values: a Fable default refuses an Opus attack given alone", () => {
    const fableDefaults: ReviewOptions = { ...defaults, model: "fable", attackModel: "fable" };
    assert.deepEqual(codes(parseReviewOptions({ attackModel: "opus" }, "cli", fableDefaults, { models })), ["fable_overall_opus_attack"]);
    assert.equal(parseReviewOptions({ model: "opus", attackModel: "opus" }, "cli", fableDefaults, { models }).ok, true);
    assert.equal(parseReviewOptions({ model: "opus", attackModel: "fable" }, "cli", defaults, { models }).ok, true);
  });

  it("a refused value is shown escaped and cut to 40 characters", () => {
    const long = "x".repeat(100);
    const result = parseReviewOptions({ model: long }, "spool", defaults, { models });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal((result.errors[0] as OptionError).value, "x".repeat(40));
    assert.equal(displayValue("o\u001b[31mpus"), "o\\u001b[31mpus");
    assert.equal(displayValue("оpus"), "\\u043epus");
    assert.equal(displayValue("a\nb"), "a\\u000ab");
    assert.equal(displayValue("😀"), "\\ud83d\\ude00");
    assert.ok(displayValue("\u0000".repeat(30)).length <= 40);
  });

  it("refuses a source that is not one of the five, and defaults that are not valid", () => {
    assert.throws(() => parseReviewOptions({}, "env" as OptionSource, defaults, { models }), TypeError);
    assert.throws(() => parseReviewOptions({}, "cli", { ...defaults, effort: "low" } as unknown as ReviewOptions, { models }), TypeError);
  });
});

describe("T-RV-02 at the CLI", () => {
  it("refuses each bad value with exit 64 and one line per error", async () => {
    for (const [value, code] of [...MODEL_REFUSALS]) {
      const run = await cli(["options", `--model=${value}`]);
      assert.equal(run.code, 64, `--model=${JSON.stringify(value)}`);
      assert.match(run.stderr, new RegExp(`^fin-review: refused: ${code}: `));
      assert.equal(run.stderr.split("\n").length, 2);
      assert.equal(run.stdout, "");
    }
    for (const [value, code] of EFFORT_REFUSALS) {
      const run = await cli(["options", "--attack-effort", value]);
      if (value === "" || value.startsWith("--")) continue;
      assert.equal(run.code, 64, `--attack-effort ${JSON.stringify(value)}`);
      assert.match(run.stderr, new RegExp(`^fin-review: refused: ${code}: `));
    }
  });

  it("refuses unknown and look-alike flags, positional arguments and a bare --", async () => {
    for (const argv of [
      ["--Model", "opus"],
      ["--MODEL=opus"],
      ["--attack_model", "fable"],
      ["--attackModel", "fable"],
      ["--attack-model-", "fable"],
      ["-m", "opus"],
      ["—model", "opus"],
      ["--mоdel", "opus"],
      [" --model", "opus"],
      ["--model ", "opus"],
      ["opus"],
      ["--"],
      ["--cold"],
      ["--=opus"],
    ]) {
      const run = await cli(["options", ...argv]);
      assert.equal(run.code, 64, JSON.stringify(argv));
      assert.match(run.stderr, /^fin-review: refused: unknown_option: /, JSON.stringify(argv));
      assert.equal(run.stdout, "");
    }
  });

  it("refuses a flag given twice, in any mix of forms", async () => {
    for (const argv of [
      ["--model", "opus", "--model", "opus"],
      ["--model=opus", "--model", "fable"],
      ["--effort", "high", "--effort=high"],
      ["--attack-model", "fable", "--attack-model=fable"],
      ["--attack-effort=max", "--attack-effort=max"],
      ["--fast", "--fast"],
    ]) {
      const run = await cli(["options", ...argv]);
      assert.equal(run.code, 64, JSON.stringify(argv));
      assert.match(run.stderr, /^fin-review: refused: duplicate_option: /);
      assert.equal(run.stderr.split("\n").length, 2, run.stderr);
    }
  });

  it("refuses a missing value and a value on --fast as wrong_type", async () => {
    for (const argv of [["--model"], ["--model", "--effort", "high"], ["--attack-effort"], ["--fast=true"], ["--fast=false"], ["--fast="]]) {
      const run = await cli(["options", ...argv]);
      assert.equal(run.code, 64, JSON.stringify(argv));
      assert.match(run.stderr, /^fin-review: refused: wrong_type: /, JSON.stringify(argv));
    }
  });

  it("--fast sets fast and says it applies to Opus sessions only", async () => {
    const run = await cli(["options", "--fast"]);
    assert.equal(run.code, 0);
    assert.equal(JSON.parse(run.stdout).options.fast, true);
    assert.equal(run.stderr, "fast: applies to Opus sessions only\n");
  });

  it("refuses before any other work: a broken machine configuration is never read", async () => {
    const home = tempDir("home-broken");
    try {
      writeFileSync(join(home.dir, "config.json"), "{ not json");
      const refused = await cli(["options", "--model", "sonnet"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(refused.code, 64);
      assert.match(refused.stderr, /^fin-review: refused: model_not_allowed: /);
      const valid = await cli(["options"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(valid.code, 78);
      assert.match(valid.stderr, /^fin-review: config: \$FIN_REVIEW_HOME\/config\.json: not valid JSON/);
    } finally {
      home.cleanup();
    }
  });

  it("machine options lay over the committed defaults, and CLI flags over both", async () => {
    const home = tempDir("home-layer");
    try {
      writeFileSync(join(home.dir, "config.json"), JSON.stringify({ options: { model: "fable", effort: "max" } }));
      const machine = await cli(["options"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(machine.code, 0, machine.stderr);
      assert.deepEqual(JSON.parse(machine.stdout).options, { ...defaults, model: "fable", effort: "max" });
      const flags = await cli(["options", "--effort", "high"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.deepEqual(JSON.parse(flags.stdout).options, { ...defaults, model: "fable", effort: "high" });
      const refused = await cli(["options", "--attack-model", "opus"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(refused.code, 64);
      assert.equal(refused.stderr, REFUSAL_LINE);
      writeFileSync(join(home.dir, "config.json"), JSON.stringify({ options: { model: "opus", model2: "x" } }));
      const unknown = await cli(["options"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(unknown.code, 78);
      assert.match(unknown.stderr, /unknown_option/);
      writeFileSync(join(home.dir, "config.json"), '{"options": {"model": "opus", "model": "fable"}}');
      const duplicate = await cli(["options"], { env: { FIN_REVIEW_HOME: home.dir } });
      assert.equal(duplicate.code, 78);
      assert.match(duplicate.stderr, /duplicate key "model"/);
      const relative = await cli(["options"], { env: { FIN_REVIEW_HOME: "relative/home" } });
      assert.equal(relative.code, 78);
      const missing = await cli(["options"], { env: { FIN_REVIEW_HOME: join(home.dir, "nowhere") } });
      assert.equal(missing.code, 0);
    } finally {
      home.cleanup();
    }
  });

  it("parseMachineOptions refuses an options value that is not an object", () => {
    assert.deepEqual(codes(parseMachineOptions({ options: "opus" }, defaults, models)), ["wrong_type"]);
    assert.deepEqual(codes(parseMachineOptions([], defaults, models)), ["wrong_type"]);
    assert.deepEqual(parseMachineOptions({ claudePath: "/opt/claude" }, defaults, models), { ok: true, value: defaults });
  });
});

describe("T-RV-05: retired model IDs", () => {
  it("refuses a model whose ID config/models.json lists as retired", () => {
    const retiring = parseModelsConfig({ opus: "claude-opus-5-5", fable: "claude-fable-5-2", retired: ["claude-fable-5-2"] });
    assert.equal(retiring.ok, true);
    if (!retiring.ok) return;
    const opusOnly: ReviewOptions = { ...defaults, attackModel: "opus" };
    const result = parseReviewOptions({ attackModel: "fable" }, "cli", opusOnly, { models: retiring.value });
    assert.deepEqual(result, {
      ok: false,
      errors: [
        {
          code: "model_retired",
          field: "attackModel",
          value: "claude-fable-5-2",
          message: "attackModel fable resolves to claude-fable-5-2, which config/models.json lists as retired.",
        },
      ],
    });
    assert.deepEqual(codes(parseReviewOptions({ model: "fable", attackModel: "fable" }, "spool", opusOnly, { models: retiring.value })), [
      "model_retired",
      "model_retired",
    ]);
    assert.equal(parseReviewOptions({}, "spool", opusOnly, { models: retiring.value }).ok, true);
  });

  it("a defaults file that uses a retired model makes every command exit 78", async () => {
    const engine = copyEngine();
    try {
      writeFileSync(join(engine.configDir, "models.json"), JSON.stringify({ opus: "claude-opus-5-5", fable: "claude-fable-5-2", retired: ["claude-fable-5-2"] }));
      for (const command of ["options", "plan", "help"]) {
        const run = await cli([command], { configDir: engine.configDir });
        assert.equal(run.code, 78, command);
        assert.match(run.stderr, /^fin-review: config: defaults\.json: model_retired: /);
      }
      writeFileSync(join(engine.configDir, "defaults.json"), JSON.stringify({ ...defaults, attackModel: "opus" }));
      const ok = await cli(["options"], { configDir: engine.configDir });
      assert.equal(ok.code, 0, ok.stderr);
      const refused = await cli(["options", "--attack-model", "fable"], { configDir: engine.configDir });
      assert.equal(refused.code, 64);
      assert.match(refused.stderr, /^fin-review: refused: model_retired: /);
    } finally {
      engine.cleanup();
    }
  });
});

describe("config/models.json and config/defaults.json", () => {
  it("the committed files hold spec 07 §3.1's values", () => {
    assert.deepEqual({ ...models, retired: [...models.retired] }, { opus: "claude-opus-5-5", fable: "claude-fable-5-2", retired: [] });
    assert.deepEqual({ ...defaults }, { model: "opus", effort: "xhigh", attackModel: "fable", attackEffort: "high", fast: false });
  });

  it("parseModelsConfig refuses every malformed file", () => {
    const good = { opus: "claude-opus-5-5", fable: "claude-fable-5-2", retired: [] };
    for (const bad of [
      null,
      [],
      {},
      { ...good, sonnet: "claude-sonnet-4-6" },
      { ...good, opus: "opus" },
      { ...good, opus: "claude-fable-5-2" },
      { ...good, fable: "claude-opus-5-5" },
      { ...good, fable: "claude-fable-5.2" },
      { ...good, retired: "claude-opus-5-5" },
      { ...good, retired: ["opus"] },
      { ...good, retired: ["claude-opus-5-5", "claude-opus-5-5"] },
      { opus: "claude-opus-5-5", fable: "claude-fable-5-2" },
    ]) {
      assert.equal(parseModelsConfig(bad).ok, false, JSON.stringify(bad));
    }
  });

  it("parseDefaultsConfig needs all five keys and refuses anything R11 refuses", () => {
    assert.equal(parseDefaultsConfig({ ...defaults }, models).ok, true);
    for (const bad of [
      { model: "opus" },
      { ...defaults, extra: 1 },
      { ...defaults, model: "sonnet" },
      { ...defaults, effort: "medium" },
      { ...defaults, fast: "false" },
      { ...defaults, model: "fable", attackModel: "opus" },
      [],
      null,
    ]) {
      const result = parseDefaultsConfig(bad, models);
      assert.equal(result.ok, false, JSON.stringify(bad));
    }
    const missing = parseDefaultsConfig({ model: "opus" }, models);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.ok(missing.errors.every((error) => error.startsWith("wrong_type: ")));
  });
});
