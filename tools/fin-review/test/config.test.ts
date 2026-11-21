// The committed configuration: every file validated when loaded, and any invalid file makes every
// command exit 78 (spec 07 §3.2 rule 2, T-RV-02's last clause). Also config/env-refusals.json
// against spec 07 §4.3's table.

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { CONFIG_FILES, loadEngineConfig } from "../src/config.ts";
import type { EnvRefusals } from "../src/env-refusals.ts";
import { checkEnvironment, checkSettings, parseEnvRefusals } from "../src/env-refusals.ts";
import { CONFIG_DIR, cli, copyEngine, spawnCli } from "./helpers/cli.ts";

/**
 * The environment of a command an agent session's Bash tool runs, as Claude Code 2.1.328 builds
 * it: the names a real agent session's commands carried, with the values replaced. The client's
 * tool-environment builder sets CLAUDECODE, CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION,
 * CLAUDE_CODE_CHILD_NOTES_DIR, CLAUDE_CODE_SESSION_ATTENDED, CLAUDE_PID, AI_AGENT and, whenever the
 * session has an effort level, CLAUDE_EFFORT; the Bash tool adds CLAUDE_CODE_EXECPATH; the session
 * process itself holds CLAUDE_CODE_ENTRYPOINT, CLAUDE_AGENT_SDK_VERSION and the messaging socket
 * and token it publishes for its own messages.
 */
const AGENT_SESSION_ENV: Readonly<Record<string, string>> = {
  HOME: "/home/x",
  SHELL: "/bin/zsh",
  LANG: "en_US.UTF-8",
  USER: "x",
  TMPDIR: "/tmp/",
  GIT_EDITOR: "true",
  AI_AGENT: "claude-code/agent",
  CLAUDECODE: "1",
  CLAUDE_AGENT_SDK_VERSION: "0.3.328",
  CLAUDE_CODE_CHILD_NOTES_DIR: "/tmp/claude-notes/fixture-session",
  CLAUDE_CODE_CHILD_SESSION: "1",
  CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
  CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude",
  CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/4242.sock",
  CLAUDE_CODE_MESSAGING_TOKEN: "fixture-token",
  CLAUDE_CODE_SESSION_ATTENDED: "0",
  CLAUDE_CODE_SESSION_ID: "fixture-session",
  CLAUDE_EFFORT: "xhigh",
  CLAUDE_PID: "4242",
};

/**
 * Names the client sets for commands it starts elsewhere: hooks and MCP servers
 * (CLAUDE_PROJECT_DIR, CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS, also inherited by a session another
 * one launched) and a session an IDE drives (CLAUDE_CODE_SSE_PORT).
 */
const CLIENT_SET_ELSEWHERE: Readonly<Record<string, string>> = {
  CLAUDE_PROJECT_DIR: "/home/x/fin-next",
  CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS: "fixture-parent",
  CLAUDE_CODE_SSE_PORT: "51234",
};

/**
 * Names a machine's own configuration can put into every agent session (a settings env block that
 * points the client at a proxy, a token for it, another configuration folder): spec 07 §4.3
 * refuses each, so the engine runs only with them removed from its own environment.
 */
const MACHINE_CONFIGURED: Readonly<Record<string, string>> = {
  ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
  ANTHROPIC_AUTH_TOKEN: "x",
  CLAUDE_CONFIG_DIR: "/home/x/.claude-other",
};

describe("loading the committed configuration", () => {
  it("every committed file is valid", () => {
    const loaded = loadEngineConfig(CONFIG_DIR);
    assert.equal(loaded.ok, true, loaded.ok ? "" : JSON.stringify(loaded.problems));
  });

  it("names every file the loader reads", () => {
    assert.deepEqual([...CONFIG_FILES].sort(), [
      "ci-map.json",
      "ci.json",
      "defaults.json",
      "env-refusals.json",
      "floor.json",
      "models.json",
    ]);
  });
});

describe("an invalid configuration file makes every command exit 78", () => {
  let engine: ReturnType<typeof copyEngine>;
  const originals = new Map<string, string>();
  before(() => {
    engine = copyEngine();
    for (const file of CONFIG_FILES)
      originals.set(file, readFileSync(join(engine.configDir, file), "utf8"));
  });
  after(() => engine.cleanup());

  const restore = (): void => {
    for (const [file, text] of originals) writeFileSync(join(engine.configDir, file), text);
  };

  const DEFAULTS_VARIANTS: Array<[string, string]> = [
    ["not JSON", "{ model: opus }"],
    ["empty", ""],
    [
      "a byte order mark",
      '﻿{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "trailing text",
      '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false} x',
    ],
    [
      "a duplicate key",
      '{"model":"opus","model":"fable","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "a __proto__ key",
      '{"__proto__":{},"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "a missing key",
      '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high"}',
    ],
    [
      "sonnet",
      '{"model":"sonnet","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "a bare model ID",
      '{"model":"claude-opus-5-5","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "effort medium",
      '{"model":"opus","effort":"medium","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "a padded value",
      '{"model":"opus ","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":false}',
    ],
    [
      "fast as a string",
      '{"model":"opus","effort":"xhigh","attackModel":"fable","attackEffort":"high","fast":"false"}',
    ],
    [
      "Fable overall, Opus attack",
      '{"model":"fable","effort":"xhigh","attackModel":"opus","attackEffort":"high","fast":false}',
    ],
    ["an array", "[]"],
  ];

  for (const [label, text] of DEFAULTS_VARIANTS) {
    it(`defaults.json with ${label}`, async () => {
      writeFileSync(join(engine.configDir, "defaults.json"), text);
      try {
        for (const argv of [
          ["options"],
          ["plan", "--base", "a".repeat(40), "--head", "b".repeat(40)],
          ["help"],
          ["nonsense"],
          [],
        ]) {
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
        if (!loaded.ok)
          assert.ok(
            loaded.problems.some((problem) => problem.file === file),
            JSON.stringify(loaded.problems),
          );
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
  const TABLE_SETTINGS_KEYS = [
    "model",
    "availableModels",
    "effortLevel",
    "maxEffortLevel",
    "modelSettings",
    "apiKeyHelper",
    "fallbackModel",
  ];

  /**
   * Names the pinned Claude Code reads that change the model, effort, endpoint, credential or
   * settings source, beyond §4.3's table, with the kind each is refused as. CLAUDE_CODE_EXTRA_BODY
   * is merged into every request body after the model, max_tokens and thinking, so it can replace
   * all three and the effort.
   */
  const BEYOND_TABLE: ReadonlyArray<readonly [string, string]> = [
    ["ANTHROPIC_DEFAULT_FABLE_MODEL", "model"],
    ["ANTHROPIC_DEFAULT_MODEL", "model"],
    ["ANTHROPIC_CUSTOM_MODEL_OPTION", "model"],
    ["FALLBACK_FOR_ALL_PRIMARY_MODELS", "model"],
    ["CLAUDE_CODE_ALLOW_OTHER_MODELS", "model"],
    ["CLAUDE_CODE_DISABLE_THINKING", "model"],
    ["CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING", "model"],
    ["CLAUDE_CODE_SUBAGENT_EFFORT", "model"],
    ["CLAUDE_CODE_EXTRA_BODY", "model"],
    ["CLAUDE_CODE_MAX_OUTPUT_TOKENS", "model"],
    ["CLAUDE_CODE_API_BASE_URL", "endpoint"],
    ["ANTHROPIC_FOUNDRY_BASE_URL", "endpoint"],
    ["ANTHROPIC_AWS_BASE_URL", "endpoint"],
    ["ANTHROPIC_GOOGLE_CLOUD_BASE_URL", "endpoint"],
    ["ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "endpoint"],
    ["ANTHROPIC_CUSTOM_HEADERS", "endpoint"],
    ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "endpoint"],
    ["CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "endpoint"],
    ["CLAUDE_CODE_USE_GATEWAY", "endpoint"],
    ["CLAUDE_CODE_USE_MANTLE", "endpoint"],
    ["CLAUDE_CODE_HTTPS_PROXY", "endpoint"],
    ["CLAUDE_CODE_HTTP_PROXY", "endpoint"],
    ["CLAUDE_CODE_PROXY_URL", "endpoint"],
    ["CLAUDE_CODE_CUSTOM_OAUTH_URL", "endpoint"],
    ["USE_LOCAL_OAUTH", "endpoint"],
    ["USE_STAGING_OAUTH", "endpoint"],
    ["CLAUDE_LOCAL_OAUTH_API_BASE", "endpoint"],
    ["CLAUDE_LOCAL_OAUTH_APPS_BASE", "endpoint"],
    ["CLAUDE_LOCAL_OAUTH_CONSOLE_BASE", "endpoint"],
    ["CLAUDE_BRIDGE_BASE_URL", "endpoint"],
    ["SESSION_INGRESS_URL", "endpoint"],
    ["AWS_ENDPOINT_URL_BEDROCK_RUNTIME", "endpoint"],
    ["NODE_EXTRA_CA_CERTS", "endpoint"],
    ["NODE_TLS_REJECT_UNAUTHORIZED", "endpoint"],
    ["SSL_CERT_FILE", "endpoint"],
    ["ANTHROPIC_FOUNDRY_API_KEY", "credential"],
    ["ANTHROPIC_FOUNDRY_AUTH_TOKEN", "credential"],
    ["ANTHROPIC_AWS_API_KEY", "credential"],
    ["AWS_BEARER_TOKEN_BEDROCK", "credential"],
    ["CLAUDE_CODE_GATEWAY_TOKEN", "credential"],
    ["CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "credential"],
    ["CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "credential"],
    ["CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "credential"],
    ["CLAUDE_CODE_SESSION_ACCESS_TOKEN", "credential"],
    ["CLAUDE_CODE_OAUTH_CLIENT_ID", "credential"],
    ["ANTHROPIC_IDENTITY_TOKEN", "credential"],
    ["CLAUDE_CODE_MANAGED_SETTINGS_PATH", "settings"],
    ["CLAUDE_CODE_MOCK_REMOTE_SETTINGS", "settings"],
    ["CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION", "settings"],
    ["CLAUDE_CONFIG_DIR", "settings"],
    ["ANTHROPIC_CONFIG_DIR", "settings"],
    ["BUN_OPTIONS", "injection"],
    ["CLAUDE_CODE_PROCESS_WRAPPER", "injection"],
  ];

  /** The names a refused family would catch that the engine needs, each for its own reason. */
  const ALLOWED = [
    "ANTHROPIC_FEDERATION_RULE_ID", // §4.3's CI federation inputs
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", // §4.3 sets it for every session
    "CLAUDE_CODE_OAUTH_TOKEN", // §7.3's local credential, which a session receives
    "NO_PROXY",
  ];

  /**
   * The names Claude Code sets in the environment of the commands its tools run, which only say
   * which session is calling. fin-review runs from agents' Claude Code sessions, so these must not
   * stop it; none reaches a review session, whose environment is built from nothing (§4.3).
   */
  const SESSION_MARKERS = [
    "CLAUDECODE",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_CHILD_NOTES_DIR",
    "CLAUDE_CODE_CHILD_SESSION",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_EXECPATH",
    "CLAUDE_CODE_LAUNCHED_BY_SESSION_IDS",
    "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDE_CODE_MESSAGING_TOKEN",
    "CLAUDE_CODE_SESSION_ATTENDED",
    "CLAUDE_CODE_SESSION_ID",
    "CLAUDE_CODE_SSE_PORT",
    "CLAUDE_EFFORT",
    "CLAUDE_PID",
    "CLAUDE_PROJECT_DIR",
  ];
  /**
   * The markers a refused family covers, each with that one family. CLAUDE_EFFORT is the calling
   * session's effort, which the client writes into every tool command and never reads; §4.3 refuses
   * CLAUDE_CODE_EFFORT_LEVEL, the name the client reads.
   */
  const MARKERS_IN_A_FAMILY: Readonly<Record<string, string>> = { CLAUDE_EFFORT: "model" };

  it("contains §4.3's table, kinds included", () => {
    for (const [kind, names] of Object.entries(TABLE)) {
      for (const name of names) {
        assert.deepEqual(
          refusals.variables.find((variable) => variable.name === name)?.kind,
          kind,
          name,
        );
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
    assert.deepEqual(
      checkEnvironment({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, refusals),
      [],
    );
    assert.deepEqual(
      checkEnvironment({ PATH: "/usr/bin", HOME: "/home/x", ANTHROPIC: "x" }, refusals),
      [],
    );
    assert.deepEqual(checkEnvironment({ NODE_OPTIONS: undefined }, refusals), []);
  });

  it("checkEnvironment refuses every name beyond the table that changes the model, effort, endpoint, credential or settings source", () => {
    for (const [name, kind] of BEYOND_TABLE) {
      assert.deepEqual(
        checkEnvironment(
          { [name]: '{"model":"claude-haiku-4-5","output_config":{"effort":"low"}}' },
          refusals,
        ),
        [{ name, kind }],
        name,
      );
    }
  });

  it("checkEnvironment refuses every CLAUDE*, ANTHROPIC_* and OAUTH name by default, and allows only the names the engine needs", () => {
    assert.deepEqual([...refusals.allowed].sort(), ALLOWED);
    for (const name of ALLOWED)
      assert.deepEqual(checkEnvironment({ [name]: "x" }, refusals), [], name);
    // Names the client may read today or add tomorrow: none is known to be harmless.
    for (const [name, kind] of [
      ["CLAUDEAI_CONNECTORS_DISABLED", "client"],
      ["CLAUDE_CODE_SIMPLE", "client"],
      ["CLAUDE_CODE_PLUGIN_DIRS", "client"],
      ["CLAUDE_CODE_SOMETHING_NEXT_RELEASE_ADDS", "client"],
      ["CLAUDE_ENV_FILE", "client"],
      ["CLAUDE_CODE_SHELL_PREFIX", "client"],
      ["CLAUDE_CODE_SESSION_SOMETHING", "client"],
      ["claude_code_simple", "client"],
      ["CCR_ANYTHING", "client"],
      ["ANTHROPIC_WORKSPACE_ID", "endpoint"],
      ["ANTHROPIC_BETAS", "endpoint"],
      ["CLAUDE_CODE_NEW_EXTRA_BODY_FIELD", "model"],
      ["MAX_MCP_OUTPUT_TOKENS", "model"],
      ["USE_OTHER_OAUTH", "credential"],
      ["CLAUDE_CODE_OAUTH_SCOPES", "credential"],
    ] as const) {
      assert.deepEqual(checkEnvironment({ [name]: "1" }, refusals), [{ name, kind }], name);
    }
  });

  it("checkEnvironment tolerates the markers of the calling Claude Code session, and nothing beside them", () => {
    assert.deepEqual([...refusals.sessionMarkers].sort(), SESSION_MARKERS);
    for (const name of SESSION_MARKERS) {
      for (const spelled of [name, name.toLowerCase()]) {
        assert.deepEqual(checkEnvironment({ [spelled]: "1" }, refusals), [], spelled);
      }
    }
    // A marker is never a name that changes the model, effort, endpoint, credential or settings
    // source: only the client's own families (kind client) would refuse one, but for the named
    // exceptions, each in the one family it names.
    for (const name of SESSION_MARKERS) {
      assert.equal(
        refusals.variables.some((variable) => variable.name === name),
        false,
        name,
      );
      const kinds = refusals.patterns
        .filter((pattern) =>
          pattern.match === "prefix" ? name.startsWith(pattern.text) : name.includes(pattern.text),
        )
        .map((pattern) => pattern.kind);
      assert.ok(kinds.length > 0, `${name} needs no entry`);
      const family = MARKERS_IN_A_FAMILY[name];
      assert.deepEqual(
        [...new Set(kinds)].sort(),
        family === undefined ? ["client"] : ["client", family].sort(),
        name,
      );
    }
    // A real agent session's tool environment passes, and so do the names the client sets for the
    // commands it starts elsewhere.
    const session = { PATH: "/usr/bin:/bin", ...AGENT_SESSION_ENV, CLAUDE_CODE_OAUTH_TOKEN: "x" };
    assert.deepEqual(checkEnvironment(session, refusals), []);
    assert.deepEqual(checkEnvironment({ ...session, ...CLIENT_SET_ELSEWHERE }, refusals), []);
    // A refused name beside them is still refused: the machine's own configuration, the effort the
    // client reads, and the effort family's other names.
    assert.deepEqual(
      checkEnvironment(
        {
          ...session,
          ...MACHINE_CONFIGURED,
          CLAUDE_CODE_EFFORT_LEVEL: "low",
          CLAUDE_CODE_SUBAGENT_EFFORT: "low",
          CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: "1",
        },
        refusals,
      ),
      [
        { name: "ANTHROPIC_AUTH_TOKEN", kind: "credential" },
        { name: "ANTHROPIC_BASE_URL", kind: "endpoint" },
        { name: "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT", kind: "model" },
        { name: "CLAUDE_CODE_EFFORT_LEVEL", kind: "model" },
        { name: "CLAUDE_CODE_SUBAGENT_EFFORT", kind: "model" },
        { name: "CLAUDE_CONFIG_DIR", kind: "settings" },
      ],
    );
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
    for (const [name, kind] of families)
      assert.deepEqual(checkEnvironment({ [name]: "1" }, refusals), [{ name, kind }], name);
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
    for (const key of refusals.settingsKeys)
      assert.deepEqual(checkSettings({ [key]: "x", theme: "dark" }, refusals), [key]);
    for (const key of [
      "hooks",
      "modelOverrides",
      "proxyAuthHelper",
      "awsCredentialExport",
      "awsAuthRefresh",
      "gcpAuthRefresh",
      "otelHeadersHelper",
      "statusLine",
      "agent",
    ]) {
      assert.deepEqual(checkSettings({ [key]: {} }, refusals), [key], key);
    }
    assert.deepEqual(
      checkSettings(
        { hooks: { SessionStart: [{ hooks: [{ type: "command", command: "x" }] }] } },
        refusals,
      ),
      ["hooks"],
    );
    assert.deepEqual(
      checkSettings({ modelOverrides: { "claude-fable-5-2": "claude-haiku-5-5" } }, refusals),
      ["modelOverrides"],
    );
  });

  it("checkSettings refuses any key it does not know to be harmless, with the key escaped", () => {
    assert.deepEqual(
      checkSettings({ someFutureKey: true, theme: "dark", verbose: true, $schema: "x" }, refusals),
      ["someFutureKey"],
    );
    assert.deepEqual(checkSettings({ "a\nb": 1 }, refusals), ["a\\u000ab"]);
    for (const key of refusals.settingsAllowedKeys)
      assert.deepEqual(checkSettings({ [key]: true }, refusals), [], key);
  });

  it("checkSettings refuses every env entry, whatever it names", () => {
    assert.deepEqual(
      checkSettings({ env: { CLAUDE_CODE_SUBAGENT_MODEL: "x", FOO: "y" } }, refusals),
      ["env.CLAUDE_CODE_SUBAGENT_MODEL", "env.FOO"],
    );
    assert.deepEqual(checkSettings({ env: { anthropic_api_key: "x" } }, refusals), [
      "env.anthropic_api_key",
    ]);
    assert.deepEqual(
      checkSettings({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: "https://example.com" } }, refusals),
      ["env.OTEL_EXPORTER_OTLP_ENDPOINT"],
    );
    assert.deepEqual(checkSettings({ env: "x" }, refusals), ["env"]);
    assert.deepEqual(checkSettings({ env: {} }, refusals), []);
  });

  it("checkSettings lets permissions only narrow §4.2's grant", () => {
    assert.deepEqual(checkSettings({ theme: "dark", permissions: {} }, refusals), []);
    assert.deepEqual(
      checkSettings(
        {
          permissions: {
            allow: ["Read", "Grep", "Glob"],
            deny: ["Bash"],
            ask: ["Write"],
            defaultMode: "dontAsk",
            disableBypassPermissionsMode: "disable",
          },
        },
        refusals,
      ),
      [],
    );
    assert.deepEqual(
      checkSettings({ permissions: { allow: ["Read", "Bash", "Read(//etc/**)"] } }, refusals),
      ["permissions.allow[1]", "permissions.allow[2]"],
    );
    for (const mode of ["bypassPermissions", "acceptEdits", "auto", "yolo"]) {
      assert.deepEqual(
        checkSettings({ permissions: { defaultMode: mode } }, refusals),
        ["permissions.defaultMode"],
        mode,
      );
    }
    assert.deepEqual(checkSettings({ permissions: { additionalDirectories: ["/"] } }, refusals), [
      "permissions.additionalDirectories",
    ]);
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
      { ...good, sessionMarkers: undefined },
      { ...good, sessionMarkers: ["CLAUDECODE", "CLAUDECODE"] },
      { ...good, sessionMarkers: ["claudecode"] },
      { ...good, sessionMarkers: ["CLAUDE_CODE_EFFORT_LEVEL"] }, // a listed refusal
      { ...good, sessionMarkers: ["CLAUDE_EFFORT"] }, // the effort family, with no exception
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "credential", why: "x" }] },
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "client", why: "x" }] },
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "other", why: "x" }] },
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "model" }] }, // no reason
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "model", why: "" }] },
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT", family: "model", why: "x", n: 1 }] },
      { ...good, sessionMarkers: [{ name: "claude_effort", family: "model", why: "x" }] },
      { ...good, sessionMarkers: [{ name: "CLAUDE_CODE_SESSION_ID", family: "model", why: "x" }] },
      {
        ...good,
        sessionMarkers: [{ name: "CLAUDE_CODE_EFFORT_LEVEL", family: "model", why: "x" }],
      },
      { ...good, sessionMarkers: [{ name: "CLAUDE_EFFORT_OAUTH", family: "model", why: "x" }] },
      {
        ...good,
        sessionMarkers: ["CLAUDECODE", { name: "CLAUDECODE", family: "model", why: "x" }],
      },
      { ...good, sessionMarkers: ["CLAUDE_CODE_OAUTH_TOKEN"] }, // an allowed name
      { ...good, sessionMarkers: ["CLAUDE_CODE_SESSION_MODEL"] }, // a model family
      { ...good, sessionMarkers: ["CLAUDE_CODE_SESSION_OAUTH"] }, // a credential family
      { ...good, sessionMarkers: ["CLAUDE_CODE_USE_SESSION"] }, // a provider switch
      { ...good, sessionMarkers: ["ANTHROPIC_SESSION_ID"] }, // the endpoint family
      { ...good, sessionMarkers: ["PATH"] }, // refused by nothing, so no marker
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
  const raw = JSON.parse(readFileSync(join(CONFIG_DIR, "env-refusals.json"), "utf8")) as {
    variables: Array<{ name: string; allowedValue?: string }>;
  };

  it("options exits 78 with environment_refused for each listed name, before reading its arguments", async () => {
    for (const { name } of raw.variables) {
      const run = await cli(["options", "--model", "sonnet"], {
        env: { PATH: process.env["PATH"], [name]: "x" },
      });
      assert.equal(run.code, 78, name);
      assert.equal(run.stdout, "");
      assert.equal(
        run.stderr,
        `fin-review: refused: environment_refused: ${name} is set (${checkKind(name)}); unset it to run fin-review.\n`,
        name,
      );
    }
  });

  it("as a real process, and for a family name, escaped", () => {
    const run = spawnCli(["options"], {
      env: {
        PATH: process.env["PATH"],
        ANTHROPIC_NEW_ENDPOINT: "x",
        CLAUDE_X_MODEL: "y",
        CLAUDE_CODE_SIMPLE: "1",
        CLAUDECODE: "1",
      },
    });
    assert.equal(run.code, 78);
    assert.match(run.stderr, /environment_refused: ANTHROPIC_NEW_ENDPOINT is set \(endpoint\)/);
    assert.match(run.stderr, /environment_refused: CLAUDE_X_MODEL is set \(model\)/);
    assert.match(run.stderr, /environment_refused: CLAUDE_CODE_SIMPLE is set \(client\)/);
    assert.doesNotMatch(run.stderr, /CLAUDECODE/, "a session marker is not refused");
  });

  it("runs from a real Claude Code agent session's tool environment, as a real process", () => {
    // EX-09 and §7.1: the merge gate runs in the agents' sessions, so the names Claude Code sets in
    // every command its Bash tool runs must not stop it, the session's effort level included.
    const env = {
      ...AGENT_SESSION_ENV,
      ...CLIENT_SET_ELSEWHERE,
      PATH: process.env["PATH"],
      HOME: process.env["HOME"],
    };
    const run = spawnCli(["options"], { env });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).v, 1);
    const steered = spawnCli(["options"], {
      env: { ...env, CLAUDE_CODE_SUBAGENT_MODEL: "claude-haiku-4-5" },
    });
    assert.equal(steered.code, 78);
    assert.equal(
      steered.stderr,
      "fin-review: refused: environment_refused: CLAUDE_CODE_SUBAGENT_MODEL is set (model); unset it to run fin-review.\n",
    );
    // A machine whose own configuration puts refused names into every session: the engine names
    // each and stops, and runs once they are removed from its own environment (the README's form).
    const configured = spawnCli(["options"], { env: { ...env, ...MACHINE_CONFIGURED } });
    assert.equal(configured.code, 78);
    assert.equal(
      configured.stderr,
      [
        "ANTHROPIC_AUTH_TOKEN is set (credential)",
        "ANTHROPIC_BASE_URL is set (endpoint)",
        "CLAUDE_CONFIG_DIR is set (settings)",
      ]
        .map(
          (what) =>
            `fin-review: refused: environment_refused: ${what}; unset it to run fin-review.\n`,
        )
        .join(""),
    );
  });

  it("refuses a request body that would replace the model and effort, as a real process", () => {
    const body = '{"model":"claude-haiku-4-5","output_config":{"effort":"low"}}';
    const run = spawnCli(["options"], {
      env: { PATH: process.env["PATH"], CLAUDE_CODE_EXTRA_BODY: body },
    });
    assert.equal(run.code, 78);
    assert.equal(run.stdout, "");
    assert.equal(
      run.stderr,
      "fin-review: refused: environment_refused: CLAUDE_CODE_EXTRA_BODY is set (model); unset it to run fin-review.\n",
      "the value is never printed",
    );
  });

  it("plan and help do not check it: CI's plan job and a help text start no session", async () => {
    const help = await cli(["help"], {
      env: { PATH: process.env["PATH"], ANTHROPIC_API_KEY: "x" },
    });
    assert.equal(help.code, 0);
    const plan = await cli(["plan"], {
      env: { PATH: process.env["PATH"], ANTHROPIC_API_KEY: "x" },
    });
    assert.equal(plan.code, 64, "plan goes on to its own argument checks");
    const clean = await cli(["options"], {
      env: { PATH: process.env["PATH"], ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    });
    assert.equal(clean.code, 0, clean.stderr);
  });
});

function checkKind(name: string): string {
  const parsed = parseEnvRefusals(
    JSON.parse(readFileSync(join(CONFIG_DIR, "env-refusals.json"), "utf8")) as unknown,
  );
  if (!parsed.ok) throw new Error("env-refusals.json is invalid");
  return checkEnvironment({ [name]: "x" }, parsed.value)[0]?.kind ?? "";
}
