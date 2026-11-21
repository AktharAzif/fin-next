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
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.errors.join("; "));
  const refusals = (parsed as { ok: true; value: EnvRefusals }).value;

  /** §4.3's table: a floor the file must contain, never a ceiling. */
  const TABLE: Record<string, string[]> = {
    endpoint: [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_BEDROCK_BASE_URL",
      "ANTHROPIC_VERTEX_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
    ],
    model: [
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
      "CLAUDE_CODE_SUBAGENT_MODEL",
      "CLAUDE_CODE_EFFORT_LEVEL",
      "MAX_THINKING_TOKENS",
    ],
    credential: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
    injection: ["NODE_OPTIONS"],
  };
  const TABLE_SETTINGS_KEYS = ["model", "availableModels", "effortLevel", "maxEffortLevel", "modelSettings", "apiKeyHelper", "fallbackModel"];

  /** Names the pinned Claude Code reads that change the model, effort, endpoint, credential or settings source, beyond §4.3's table. */
  const BEYOND_TABLE = [
    "ANTHROPIC_DEFAULT_FABLE_MODEL",
    "ANTHROPIC_DEFAULT_MODEL",
    "ANTHROPIC_CUSTOM_MODEL_OPTION",
    "FALLBACK_FOR_ALL_PRIMARY_MODELS",
    "CLAUDE_CODE_ALLOW_OTHER_MODELS",
    "CLAUDE_CODE_DISABLE_THINKING",
    "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
    "CLAUDE_CODE_SUBAGENT_EFFORT",
    "CLAUDE_EFFORT",
    "CLAUDE_CODE_API_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_GOOGLE_CLOUD_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_HTTPS_PROXY",
    "CLAUDE_CODE_HTTP_PROXY",
    "CLAUDE_CODE_PROXY_URL",
    "NODE_EXTRA_CA_CERTS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "SSL_CERT_FILE",
    "ANTHROPIC_FOUNDRY_API_KEY",
    "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
    "ANTHROPIC_AWS_API_KEY",
    "AWS_BEARER_TOKEN_BEDROCK",
    "CLAUDE_CODE_GATEWAY_TOKEN",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_IDENTITY_TOKEN",
    "CLAUDE_CODE_MANAGED_SETTINGS_PATH",
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_CONFIG_DIR",
    "BUN_OPTIONS",
  ];

  it("contains §4.3's table, kinds included", () => {
    for (const [kind, names] of Object.entries(TABLE)) {
      for (const name of names) {
        assert.deepEqual(refusals.variables.find((variable) => variable.name === name)?.kind, kind, name);
      }
    }
    for (const key of TABLE_SETTINGS_KEYS) assert.ok(refusals.settingsKeys.includes(key), key);
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
    assert.deepEqual(checkEnvironment({ PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC: "x" }, refusals), []);
    assert.deepEqual(checkEnvironment({ NODE_OPTIONS: undefined }, refusals), []);
  });

  it("checkEnvironment refuses every name beyond the table that changes the model, effort, endpoint or credential", () => {
    for (const name of BEYOND_TABLE) {
      const found = checkEnvironment({ [name]: "1" }, refusals);
      assert.equal(found.length, 1, name);
    }
  });

  it("checkEnvironment refuses new variants by their family, and lets through the names the engine needs", () => {
    const families: Array<[string, string]> = [
      ["ANTHROPIC_SOMETHING_NEW", "endpoint"],
      ["CLAUDE_CODE_USE_NEW_CLOUD", "endpoint"],
      ["NODE_DEBUG", "injection"],
      ["BUN_CONFIG_REGISTRY", "injection"],
      ["SSL_CERT_DIR", "endpoint"],
      ["CLAUDE_CODE_NEW_BASE_URL", "endpoint"],
      ["https_proxy", "endpoint"],
      ["SOCKS_PROXY", "endpoint"],
      ["CLAUDE_NEW_API_KEY", "credential"],
      ["CLAUDE_NEW_AUTH_TOKEN", "credential"],
      ["CLAUDE_CODE_AUTO_MODE_MODEL", "model"],
      ["CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", "model"],
      ["CLAUDE_CODE_NEW_THINKING_MODE", "model"],
      ["CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK", "model"],
    ];
    for (const [name, kind] of families) assert.deepEqual(checkEnvironment({ [name]: "1" }, refusals), [{ name, kind }], name);
    const harmless = {
      PATH: "/usr/bin",
      HOME: "/home/x",
      LANG: "C.UTF-8",
      TERM: "xterm",
      TMPDIR: "/tmp",
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_TOKEN: "x",
      FIN_REVIEW_HOME: "/var/fin-review",
      CLAUDE_CODE_OAUTH_TOKEN: "x",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ANTHROPIC_IDENTITY_TOKEN_FILE: "/run/token",
      ANTHROPIC_FEDERATION_RULE_ID: "rule",
      ANTHROPIC_ORGANIZATION_ID: "org",
      ANTHROPIC_SERVICE_ACCOUNT_ID: "sa",
      NO_PROXY: "localhost",
    };
    assert.deepEqual(checkEnvironment(harmless, refusals), []);
  });

  it("checkSettings refuses §4.3's keys and every key that runs a command, loads code or changes the model", () => {
    for (const key of refusals.settingsKeys) assert.deepEqual(checkSettings({ [key]: "x", theme: "dark" }, refusals), [key]);
    for (const key of ["hooks", "modelOverrides", "proxyAuthHelper", "awsCredentialExport", "awsAuthRefresh", "gcpAuthRefresh", "otelHeadersHelper", "statusLine", "agent"]) {
      assert.deepEqual(checkSettings({ [key]: {} }, refusals), [key], key);
    }
    assert.deepEqual(checkSettings({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } }, refusals), ["hooks"]);
    assert.deepEqual(checkSettings({ modelOverrides: { "claude-fable-5-2": "claude-haiku-5-5" } }, refusals), ["modelOverrides"]);
  });

  it("checkSettings refuses any key it does not know to be harmless, with the key escaped", () => {
    assert.deepEqual(checkSettings({ someFutureKey: true, theme: "dark", verbose: true, $schema: "x" }, refusals), ["someFutureKey"]);
    assert.deepEqual(checkSettings({ "a\nb": 1 }, refusals), ["a\\u000ab"]);
    for (const key of refusals.settingsAllowedKeys) assert.deepEqual(checkSettings({ [key]: true }, refusals), [], key);
  });

  it("checkSettings refuses every env entry, whatever it names", () => {
    assert.deepEqual(checkSettings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "x", FOO: "y" } }, refusals), ["env.CLAUDE_CODE_SUBAGENT_MODEL", "env.FOO"]);
    assert.deepEqual(checkSettings({ env: { anthropic_api_key: "x" } }, refusals), ["env.anthropic_api_key"]);
    assert.deepEqual(checkSettings({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com" } }, refusals), ["env.OTEL_EXPORTER_OTLP_ENDPOINT"]);
    assert.deepEqual(checkSettings({ env: "x" }, refusals), ["env"]);
    assert.deepEqual(checkSettings({ env: {} }, refusals), []);
  });

  it("checkSettings lets permissions only narrow §4.2's grant", () => {
    assert.deepEqual(checkSettings({ theme: "dark", permissions: {} }, refusals), []);
    assert.deepEqual(
      checkSettings({ permissions: { allow: ["Read", "Grep", "Glob"], deny: ["Bash"], ask: ["Write"], defaultMode: "dontAsk", disableBypassPermissionsMode: "disable" } }, refusals),
      [],
    );
    assert.deepEqual(checkSettings({ permissions: { allow: ["Read", "Bash", "Read(//etc/**)"] } }, refusals), ["permissions.allow[1]", "permissions.allow[2]"]);
    for (const mode of ["bypassPermissions", "acceptEdits", "auto", "yolo"]) {
      assert.deepEqual(checkSettings({ permissions: { defaultMode: mode } }, refusals), ["permissions.defaultMode"], mode);
    }
    assert.deepEqual(checkSettings({ permissions: { additionalDirectories: ["/"] } }, refusals), ["permissions.additionalDirectories"]);
    assert.deepEqual(checkSettings({ permissions: "all" }, refusals), ["permissions"]);
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
      { ...good, patterns: [] },
      { ...good, patterns: [{ prefix: "X_", contains: "Y", kind: "model" }] },
      { ...good, patterns: [{ kind: "model" }] },
      { ...good, patterns: [{ prefix: "x_", kind: "model" }] },
      { ...good, patterns: [{ prefix: "X_", kind: "other" }] },
      { ...good, allowed: ["ANTHROPIC_API_KEY"] },
      { ...good, allowed: ["lower"] },
      { ...good, settingsKeys: [] },
      { ...good, settingsKeys: ["model", "model"] },
      { ...good, settingsKeys: ["a b"] },
      { ...good, settingsAllowedKeys: ["model"] },
      { ...good, settingsAllowedKeys: [] },
    ]) {
      assert.equal(parseEnvRefusals(bad).ok, false, JSON.stringify(bad));
    }
  });
});

describe("the engine refuses a refused environment (T-RV-06's environment half)", () => {
  const raw = JSON.parse(readFileSync(join(CONFIG_DIR, "env-refusals.json"), "utf8")) as { variables: Array<{ name: string; allowedValue?: string }> };

  it("options exits 78 with environment_refused for each listed name, before reading its arguments", async () => {
    for (const { name } of raw.variables) {
      const run = await cli(["options", "--model", "sonnet"], { env: { PATH: process.env["PATH"], [name]: "x" } });
      assert.equal(run.code, 78, name);
      assert.equal(run.stdout, "");
      assert.equal(run.stderr, `fin-review: refused: environment_refused: ${name} is set (${checkKind(name)}); unset it to run fin-review.\n`, name);
    }
  });

  it("as a real process, and for a family name, escaped", () => {
    const run = spawnCli(["options"], { env: { PATH: process.env["PATH"], ANTHROPIC_NEW_ENDPOINT: "x", "CLAUDE_X_MODEL": "y" } });
    assert.equal(run.code, 78);
    assert.match(run.stderr, /environment_refused: ANTHROPIC_NEW_ENDPOINT is set \(endpoint\)/);
    assert.match(run.stderr, /environment_refused: CLAUDE_X_MODEL is set \(model\)/);
  });

  it("plan and help do not check it: CI's plan job and a help text start no session", async () => {
    const help = await cli(["help"], { env: { PATH: process.env["PATH"], ANTHROPIC_API_KEY: "x" } });
    assert.equal(help.code, 0);
    const plan = await cli(["plan"], { env: { PATH: process.env["PATH"], ANTHROPIC_API_KEY: "x" } });
    assert.equal(plan.code, 64, "plan goes on to its own argument checks");
    const clean = await cli(["options"], { env: { PATH: process.env["PATH"], ANTHROPIC_BASE_URL: "https://api.anthropic.com" } });
    assert.equal(clean.code, 0, clean.stderr);
  });
});

function checkKind(name: string): string {
  const parsed = parseEnvRefusals(JSON.parse(readFileSync(join(CONFIG_DIR, "env-refusals.json"), "utf8")) as unknown);
  if (!parsed.ok) throw new Error("env-refusals.json is invalid");
  return checkEnvironment({ [name]: "x" }, parsed.value)[0]?.kind ?? "";
}
