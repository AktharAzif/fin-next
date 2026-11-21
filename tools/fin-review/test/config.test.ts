// The committed configuration: every file validated when loaded, and any invalid file makes every
// command exit 78 (spec 07 §3.2 rule 2, T-RV-02's last clause). Also config/env-refusals.json
// against spec 07 §4.3's table.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFIG_FILES, loadEngineConfig } from "../src/config.ts";
import { checkEnvironment, checkSettings, parseEnvRefusals } from "../src/env-refusals.ts";
import type { EnvRefusals } from "../src/env-refusals.ts";
import { CONFIG_DIR, cli, copyEngine, spawnCli } from "./helpers/cli.ts";

describe("loading the committed configuration", () => {
  it("every committed file is valid", () => {
    const loaded = loadEngineConfig(CONFIG_DIR);
    assert.equal(loaded.ok, true, loaded.ok ? "" : JSON.stringify(loaded.problems));
  });

  it("names every file the loader reads", () => {
    assert.deepEqual([...CONFIG_FILES].sort(), ["ci-map.json", "ci.json", "defaults.json", "env-refusals.json", "floor.json", "models.json"]);
  });
});

describe("an invalid configuration file makes every command exit 78", () => {
  let engine: ReturnType<typeof copyEngine>;
  const originals = new Map<string, string>();
  before(() => {
    engine = copyEngine();
    for (const file of CONFIG_FILES) originals.set(file, readFileSync(join(engine.configDir, file), "utf8"));
  });
  after(() => engine.cleanup());

  const restore = (): void => {
    for (const [file, text] of originals) writeFileSync(join(engine.configDir, file), text);
  };

  const DEFAULTS_VARIANTS: Array<[string, string]> = [
    ["not JSON", "{ model: opus }"],
    ["empty", ""],
    ["a byte order mark", '﻿{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["trailing text", '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false} x'],
    ["a duplicate key", '{"model":"opus","model":"fable","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["a __proto__ key", '{"__proto__":{},"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["a missing key", '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high"}'],
    ["sonnet", '{"model":"sonnet","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["a bare model ID", '{"model":"claude-opus-5-5","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["effort medium", '{"model":"opus","effort":"medium","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["a padded value", '{"model":"opus ","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}'],
    ["fast as a string", '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":"false"}'],
    ["Fable overall, Opus attack", '{"model":"fable","effort":"xhigh","attackModel":"opus","attackEffort":"high","fast":false}'],
    ["an array", "[]"],
  ];

  for (const [label, text] of DEFAULTS_VARIANTS) {
    it(`defaults.json with ${label}`, async () => {
      writeFileSync(join(engine.configDir, "defaults.json"), text);
      try {
        for (const argv of [["options"], ["plan", "--base", "a".repeat(40), "--head", "b".repeat(40)], ["help"], ["nonsense"], []]) {
          const run = await cli(argv, { configDir: engine.configDir });
          assert.equal(run.code, 78, `${label}: ${JSON.stringify(argv)}`);
          assert.equal(run.stdout, "");
          assert.match(run.stderr, /^fin-review: config: defaults\.json: /);
        }
      } finally {
        restore();
      }
    });
  }

  it("defaults.json missing", async () => {
    rmSync(join(engine.configDir, "defaults.json"));
    try {
      const run = await cli(["help"], { configDir: engine.configDir });
      assert.equal(run.code, 78);
      assert.equal(run.stderr, "fin-review: config: defaults.json: missing\n");
    } finally {
      restore();
    }
  });

  it("as a real process, for every command", () => {
    writeFileSync(join(engine.configDir, "defaults.json"), '{"model":"haiku"}');
    try {
      for (const argv of [["options"], ["plan"], ["help"]]) {
        const run = spawnCli(argv, { main: engine.main });
        assert.equal(run.code, 78, JSON.stringify(argv));
        assert.equal(run.stdout, "");
      }
    } finally {
      restore();
    }
    const fine = spawnCli(["help"], { main: engine.main });
    assert.equal(fine.code, 0);
  });

  const OTHER_FILES: Array<[string, string]> = [
    ["models.json", '{"opus":"claude-opus-5-5","fable":"claude-fable-5-2"}'],
    ["floor.json", '{"version":1,"tiers":{"S":{},"N":{},"D":{}}}'],
    ["env-refusals.json", '{"version":1,"variables":[],"settingsKeys":["model"]}'],
    ["ci-map.json", '{"version":1,"always":["check"],"classes":[]}'],
    ["ci.json", '{"version":1,"e2eShards":0}'],
  ];
  for (const [file, text] of OTHER_FILES) {
    it(`${file} invalid`, async () => {
      writeFileSync(join(engine.configDir, file), text);
      try {
        const loaded = loadEngineConfig(engine.configDir);
        assert.equal(loaded.ok, false);
        if (!loaded.ok) assert.ok(loaded.problems.some((problem) => problem.file === file), JSON.stringify(loaded.problems));
        for (const argv of [["options"], ["help"]]) {
          const run = await cli(argv, { configDir: engine.configDir });
          assert.equal(run.code, 78, `${file}: ${JSON.stringify(argv)}`);
        }
      } finally {
        restore();
      }
    });
  }
});

describe("config/env-refusals.json (spec 07 §4.3)", () => {
  const raw = JSON.parse(readFileSync(join(CONFIG_DIR, "env-refusals.json"), "utf8")) as unknown;
  const parsed = parseEnvRefusals(raw);
  assert.equal(parsed.ok, true);
  const refusals = (parsed as { ok: true; value: EnvRefusals }).value;

  it("lists §4.3's table exactly", () => {
    const byKind = (kind: string): string[] =>
      refusals.variables.filter((variable) => variable.kind === kind).map((variable) => variable.name);
    assert.deepEqual(byKind("endpoint"), [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
    ]);
    assert.deepEqual(byKind("model"), [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "MAX_THINKING_TOKENS",
    ]);
    assert.deepEqual(byKind("credential"), ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]);
    assert.deepEqual(byKind("injection"), ["NODE_OPTIONS"]);
    assert.deepEqual(refusals.settingsKeys, ["model", "availableModels", "effortLevel", "maxEffortLevel", "modelSettings", "apiKeyHelper", "fallbackModel"]);
    assert.deepEqual(
      refusals.variables.filter((variable) => variable.allowedValue !== undefined),
      [{ name: "ANTHROPIC_BASE_URL", kind: "endpoint", allowedValue: "https://api.anthropic.com" }],
    );
  });

  it("checkEnvironment refuses each listed name, set to anything, in any case", () => {
    for (const variable of refusals.variables) {
      for (const name of [variable.name, variable.name.toLowerCase()]) {
        for (const value of ["x", "", "https://api.anthropic.com/"]) {
          const found = checkEnvironment({ PATH: "/usr/bin", [name]: value }, refusals);
          assert.deepEqual(found, [{ name, kind: variable.kind }], `${name}=${value}`);
        }
      }
    }
    assert.deepEqual(checkEnvironment({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, refusals), []);
    assert.deepEqual(checkEnvironment({ PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC_BASE: "x" }, refusals), []);
    assert.deepEqual(checkEnvironment({ NODE_OPTIONS: undefined }, refusals), []);
  });

  it("checkSettings refuses each settings key and an env block naming a refused variable", () => {
    for (const key of refusals.settingsKeys) assert.deepEqual(checkSettings({ [key]: "x", theme: "dark" }, refusals), [key]);
    assert.deepEqual(checkSettings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "x", FOO: "y" } }, refusals), ["env.CLAUDE_CODE_SUBAGENT_MODEL"]);
    assert.deepEqual(checkSettings({ env: { anthropic_api_key: "x" } }, refusals), ["env.anthropic_api_key"]);
    assert.deepEqual(checkSettings({ theme: "dark", permissions: {} }, refusals), []);
    assert.deepEqual(checkSettings(null, refusals), []);
  });

  it("parseEnvRefusals refuses malformed files", () => {
    const good = raw as Record<string, unknown>;
    const variables = good["variables"] as Array<Record<string, unknown>>;
    for (const bad of [
      null,
      { ...good, version: 2 },
      { ...good, extra: 1 },
      { ...good, variables: [] },
      { ...good, variables: [...variables, variables[0]] },
      { ...good, variables: [{ name: "lower_case", kind: "model" }] },
      { ...good, variables: [{ name: "X", kind: "other" }] },
      { ...good, variables: [{ name: "X", kind: "model", allowedValue: "" }] },
      { ...good, variables: [{ name: "X", kind: "model", note: "x" }] },
      { ...good, settingsKeys: [] },
      { ...good, settingsKeys: ["model", "model"] },
      { ...good, settingsKeys: ["a b"] },
    ]) {
      assert.equal(parseEnvRefusals(bad).ok, false, JSON.stringify(bad));
    }
  });
});
