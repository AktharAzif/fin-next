// The CLI runner (spec 07 §4.1 to §4.3): the argument list for each role (T-RV-07), no fallback or
// alias anywhere (T-RV-08), the settings file, and the session's environment as a fake `claude`
// sees it (T-RV-09).

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { EFFORTS, MODEL_NAMES, loadCommittedModels } from "../src/options.ts";
import type { ReviewOptions } from "../src/options.ts";
import { ROLES, sessionModel } from "../src/roles.ts";
import { CliRunner, FORBIDDEN_FLAGS, REPLACED_FLAGS, RUNNER_FLAGS, buildArgs, cliSchema, effectiveFast } from "../src/runner/cli.ts";
import { clientFingerprint, pinClient } from "../src/runner/client.ts";
import { POOL_SESSION_ENV_NAMES, SESSION_ENV_NAMES, sessionEnv } from "../src/runner/env.ts";
import { DIRECT, resolveTransport } from "../src/transport.ts";
import type { Transport } from "../src/transport.ts";
import { DENIED_TOOLS, buildSettings } from "../src/runner/settings.ts";
import type { SessionSpec } from "../src/runner/types.ts";
import { fakeClock } from "./helpers/review-fixture.ts";
import { tempDir } from "./helpers/git-fixture.ts";

const MODELS = loadCommittedModels();
const FILES = { settingsPath: "/h/.fin-review/runs/r/sessions/s/settings.json", mcpPath: "/h/.fin-review/runs/r/sessions/s/mcp.json" };
const SCHEMA = { type: "object", additionalProperties: false, required: ["answer"], properties: { answer: { type: "string", maxLength: 40 } } };

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    id: "security-s0",
    role: "lens",
    lens: "security",
    shard: 0,
    modelId: MODELS.opus,
    effort: "xhigh",
    fast: false,
    treeDir: "/h/.fin-review/trees/r",
    prompt: "the prompt",
    schema: SCHEMA,
    maxTurns: 60,
    maxBudgetUsd: 12,
    timeoutMs: 1_800_000,
    ...overrides,
  };
}

function validCombinations(): ReviewOptions[] {
  const out: ReviewOptions[] = [];
  for (const model of MODEL_NAMES)
    for (const effort of EFFORTS)
      for (const attackModel of MODEL_NAMES)
        for (const attackEffort of EFFORTS) {
          if (model === "fable" && attackModel === "opus") continue;
          out.push({ model, effort, attackModel, attackEffort, fast: false });
        }
  return out;
}

describe("the argument list (T-RV-07, T-RV-08)", () => {
  it("is exactly spec 07 §4.1's list, with the recorded replacements", () => {
    assert.deepEqual(buildArgs(spec(), FILES, "SYSTEM TEXT", MODELS), [
      "-p",
      "--model",
      MODELS.opus,
      "--effort",
      "xhigh",
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--settings",
      FILES.settingsPath,
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      FILES.mcpPath,
      "--tools",
      "Read,Grep,Glob",
      "--disallowedTools",
      "Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Agent,mcp__*",
      "--restricted",
      "--permission-prompts",
      "none",
      "--max-budget-usd",
      "12.00",
      "--no-session-persistence",
      "--exclude-dynamic-system-prompt-sections",
      "--append-system-prompt",
      "SYSTEM TEXT",
    ]);
  });

  it("passes the schema without its $schema and $id, which the pinned CLI's validator refuses", () => {
    const withMeta = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: "x", title: "t", ...SCHEMA };
    const args = buildArgs(spec({ schema: withMeta }), FILES, "S", MODELS);
    assert.equal(args[args.indexOf("--json-schema") + 1], JSON.stringify({ title: "t", ...SCHEMA }));
    assert.equal(cliSchema(withMeta).includes("$schema"), false);
  });

  it("names every flag it passes in RUNNER_FLAGS, which D2 checks", () => {
    const flags = buildArgs(spec(), FILES, "SYSTEM TEXT", MODELS).filter((arg) => /^-/.test(arg));
    assert.deepEqual([...new Set(flags)].sort(), [...RUNNER_FLAGS].sort());
    assert.deepEqual(Object.keys(REPLACED_FLAGS).sort(), ["--append-system-prompt-file", "--max-turns"]);
    for (const flag of Object.keys(REPLACED_FLAGS)) assert.ok(!RUNNER_FLAGS.includes(flag));
  });

  it("for every role and all 27 valid combinations: the exact model ID, the role's effort, never a fallback, an alias or --bare", () => {
    let lists = 0;
    for (const options of validCombinations()) {
      for (const role of ROLES) {
        const model = sessionModel(role, options, MODELS);
        const args = buildArgs(spec({ role, modelId: model.modelId, effort: model.effort }), FILES, "S", MODELS);
        lists++;
        for (const flag of FORBIDDEN_FLAGS) assert.ok(!args.includes(flag), `${role} ${flag}`);
        assert.ok(!args.some((arg) => arg.startsWith("--fallback-model")));
        const modelArg = args[args.indexOf("--model") + 1];
        assert.ok(modelArg === MODELS.opus || modelArg === MODELS.fable, modelArg ?? "");
        assert.ok(!["opus", "fable", "sonnet", "haiku", "default"].includes(modelArg ?? ""));
        assert.equal(args[args.indexOf("--effort") + 1], model.effort);
        if (role === "attack" || role === "sceptic2") assert.equal(modelArg, MODELS[options.attackModel]);
      }
    }
    assert.equal(lists, 27 * ROLES.length);
  });

  it("refuses an alias, another model ID, a retired ID, a bad effort or budget", () => {
    for (const modelId of ["opus", "fable", "claude-sonnet-4-5", "claude-opus-5-5[1m]", ""]) {
      assert.throws(() => buildArgs(spec({ modelId }), FILES, "S", MODELS), TypeError, modelId);
    }
    assert.throws(() => buildArgs(spec(), FILES, "S", { ...MODELS, retired: [MODELS.opus] }), TypeError);
    assert.throws(() => buildArgs(spec({ effort: "medium" as never }), FILES, "S", MODELS), TypeError);
    assert.throws(() => buildArgs(spec({ maxBudgetUsd: 0 }), FILES, "S", MODELS), TypeError);
    assert.throws(() => buildArgs(spec(), FILES, "--looks-like-a-flag", MODELS), TypeError);
    assert.throws(() => buildArgs(spec(), { ...FILES, settingsPath: "relative.json" }, "S", MODELS), TypeError);
  });

  it("turns fast mode on for Opus sessions only (S7-13)", () => {
    assert.equal(effectiveFast(spec({ fast: true }), MODELS), true);
    assert.equal(effectiveFast(spec({ fast: true, modelId: MODELS.fable }), MODELS), false);
    assert.equal(effectiveFast(spec({ fast: false }), MODELS), false);
  });
});

describe("the settings file (spec 07 §4.2)", () => {
  const listing: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
    "/h": [
      { name: ".fin-review", isDirectory: true },
      { name: ".ssh", isDirectory: true },
      { name: "notes.txt", isDirectory: false },
      { name: "odd(name)", isDirectory: true },
    ],
    "/h/.fin-review": [
      { name: "runs", isDirectory: true },
      { name: "trees", isDirectory: true },
      { name: "repos", isDirectory: true },
    ],
    "/h/.fin-review/trees": [
      { name: "r", isDirectory: true },
      { name: "other-run", isDirectory: true },
    ],
  };
  const listDir = (dir: string) => listing[dir] ?? [];

  it("equals the template, with the tree under the home: explicit denies around it, never ~/**", () => {
    const settings = buildSettings({ modelId: MODELS.opus, fastMode: false, home: "/h", finReviewHome: "/h/.fin-review", treeDir: "/h/.fin-review/trees/r", extraDenied: [], listDir });
    assert.equal(settings.model, MODELS.opus);
    assert.deepEqual(settings.availableModels, [MODELS.opus]);
    assert.equal(settings.availableModelsMatch, "exact");
    assert.equal(settings.switchModelsOnFlag, false);
    assert.equal(settings.fastMode, false);
    assert.deepEqual(settings.env, {});
    assert.equal(settings.permissions.defaultMode, "dontAsk");
    assert.deepEqual(settings.permissions.allow, ["Read", "Grep", "Glob"]);
    const deny = settings.permissions.deny;
    for (const tool of DENIED_TOOLS) assert.ok(deny.includes(tool), tool);
    for (const rule of ["Read(//proc/**)", "Read(//sys/**)", "Read(//dev/**)", "Read(//h/.ssh/**)", "Read(//h/notes.txt)", "Read(//h/odd?name?/**)"]) {
      assert.ok(deny.includes(rule), rule);
    }
    for (const dir of ["runs", "state", "scratch", "ledger", "repos"]) assert.ok(deny.includes(`Read(//h/.fin-review/${dir}/**)`), dir);
    assert.ok(deny.includes("Read(//h/.fin-review/trees/other-run/**)"));
    assert.ok(!deny.includes("Read(~/**)"));
    assert.ok(!deny.some((rule) => rule === "Read(//h/**)" || rule.includes("/trees/r/") || rule === "Read(//h/.fin-review/trees/**)" || rule === "Read(//h/.fin-review/**)"));
  });

  it("with the tree outside the home, denies ~/** and the home itself", () => {
    const settings = buildSettings({ modelId: MODELS.fable, fastMode: false, home: "/h", finReviewHome: "/srv/fr", treeDir: "/srv/fr/trees/r", extraDenied: ["/srv/spool"], listDir });
    assert.ok(settings.permissions.deny.includes("Read(~/**)"));
    assert.ok(settings.permissions.deny.includes("Read(//h/**)"));
    assert.ok(settings.permissions.deny.includes("Read(//srv/spool/**)"));
  });

  it("refuses a tree outside FIN_REVIEW_HOME or a denied directory holding it", () => {
    assert.throws(() => buildSettings({ modelId: MODELS.opus, fastMode: false, home: "/h", finReviewHome: "/h/.fin-review", treeDir: "/elsewhere", extraDenied: [], listDir }));
    assert.throws(() => buildSettings({ modelId: MODELS.opus, fastMode: false, home: "/h", finReviewHome: "/h/.fin-review", treeDir: "/h/.fin-review/trees/r", extraDenied: ["/h/.fin-review"], listDir }));
  });
});

describe("the session environment (spec 07 §4.3, trimmed Phase 0)", () => {
  it("holds only the allowlisted names, keeps HOME, and drops everything else", () => {
    const env = sessionEnv(
      {
        HOME: "/h",
        PATH: "/opt/bin:/usr/bin",
        GITHUB_TOKEN: "ghp_x",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.com",
        FIN_REVIEW_INGEST_TOKEN: "x",
        SSH_AUTH_SOCK: "/tmp/x",
        USER: "u",
      },
      "/h/.fin-review/scratch/s/tmp",
    );
    assert.deepEqual(env, {
      PATH: "/usr/bin:/bin",
      HOME: "/h",
      LANG: "C.UTF-8",
      TMPDIR: "/h/.fin-review/scratch/s/tmp",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    });
    for (const name of Object.keys(env)) assert.ok(SESSION_ENV_NAMES.includes(name));
  });

  it("never gives a session another configuration directory: CLAUDE_CONFIG_DIR is refused, and $HOME/.claude is denied", () => {
    assert.ok(!SESSION_ENV_NAMES.includes("CLAUDE_CONFIG_DIR"));
    assert.throws(() => sessionEnv({ HOME: "/h", CLAUDE_CONFIG_DIR: "/opt/claude-config" }, "/t"), /CLAUDE_CONFIG_DIR/);
    const listing: Record<string, Array<{ name: string; isDirectory: boolean }>> = {
      "/h": [
        { name: ".claude", isDirectory: true },
        { name: ".fin-review", isDirectory: true },
      ],
      "/h/.fin-review": [{ name: "trees", isDirectory: true }],
      "/h/.fin-review/trees": [{ name: "r", isDirectory: true }],
    };
    const listDir = (dir: string) => listing[dir] ?? [];
    const settings = buildSettings({ modelId: MODELS.opus, fastMode: false, home: "/h", finReviewHome: "/h/.fin-review", treeDir: "/h/.fin-review/trees/r", extraDenied: [], listDir });
    assert.ok(settings.permissions.deny.includes("Read(//h/.claude/**)"), settings.permissions.deny.join("\n"));
  });

  it("passes CLAUDE_CODE_OAUTH_TOKEN when the engine has one, and refuses a malformed one", () => {
    assert.equal(sessionEnv({ HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abc_DEF-123" }, "/t")["CLAUDE_CODE_OAUTH_TOKEN"], "sk-ant-oat01-abc_DEF-123");
    assert.throws(() => sessionEnv({ HOME: "/h", CLAUDE_CODE_OAUTH_TOKEN: "a b" }, "/t"));
    assert.throws(() => sessionEnv({ HOME: "relative" }, "/t"));
  });
});

describe("the CLI runner with a fake claude (T-RV-09)", () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let userHome: string;
  let claudePath: string;
  let record: string;

  before(() => {
    tmp = tempDir("fake-claude");
    userHome = realpathSync(tmp.dir);
    home = join(userHome, ".fin-review");
    mkdirSync(join(home, "trees", "run1"), { recursive: true });
    record = join(userHome, "record.json");
    claudePath = join(userHome, "bin", "claude");
    mkdirSync(join(userHome, "bin"), { recursive: true });
    // A fake `claude`: records its argv, stdin, cwd and environment names, then answers as
    // Claude Code does: a JSON result whose modelUsage names the --model it was given. With
    // SLEEP set in the prompt it hangs, for the timeout path.
    writeFileSync(
      claudePath,
      `#!${process.execPath}
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const args = process.argv.slice(2);
  const model = args[args.indexOf("--model") + 1];
  const previous = fs.existsSync(${JSON.stringify(record)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(record)}, "utf8")) : [];
  previous.push({ args, input, cwd: process.cwd(), env: Object.keys(process.env).sort(), tmpExists: fs.existsSync(process.env.TMPDIR) });
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(previous));
  if (input.includes("SLEEP")) { setTimeout(() => {}, 60000); return; }
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", stop_reason: "end_turn", total_cost_usd: 0.25,
    usage: { input_tokens: 3, cache_creation_input_tokens: 4, cache_read_input_tokens: 5, output_tokens: 6 },
    modelUsage: input.includes("MISMATCH") ? { [model]: { inputTokens: 3, outputTokens: 6 }, "claude-haiku-9-9": { inputTokens: 1, outputTokens: 1 } } : { [model]: { inputTokens: 3, outputTokens: 6 } },
    structured_output: { answer: "ready" } }) + "\\n");
});
`,
    );
    chmodSync(claudePath, 0o755);
  });
  after(() => tmp.cleanup());

  function runner(engineEnv: Record<string, string>, fingerprint: string = clientFingerprint(claudePath) ?? "", transport: Transport = DIRECT): CliRunner {
    return new CliRunner({
      transport,
      claudePath,
      claudeFingerprint: fingerprint,
      engineEnv,
      home: userHome,
      finReviewHome: home,
      runDir: join(home, "runs", "run1"),
      runId: "run1",
      systemPrompt: "SYSTEM",
      models: MODELS,
      clock: fakeClock(),
      clientVersion: "2.1.328",
      extraDenied: [],
    });
  }

  it("sees exactly the allowlisted environment, the prompt on stdin, the tree as cwd and a fresh TMPDIR", async () => {
    const engineEnv = {
      HOME: userHome,
      PATH: process.env["PATH"] ?? "",
      GITHUB_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "x",
      ACTIONS_ID_TOKEN_REQUEST_URL: "x",
      FIN_REVIEW_INGEST_TOKEN: "x",
      NODE_OPTIONS: "--require=/nowhere.js",
    };
    const treeDir = join(home, "trees", "run1");
    const result = await runner(engineEnv).run(spec({ treeDir, schema: SCHEMA, prompt: "PROMPT TEXT" }), new AbortController().signal);
    assert.equal(result.state, "ok", result.failureDetail ?? "");
    assert.deepEqual(JSON.parse(JSON.stringify(result.output)), { answer: "ready" });
    assert.deepEqual(result.modelObserved, [MODELS.opus]);
    assert.equal(result.costMicroUsd, 250_000);
    assert.equal(result.tokensIn, 7);
    assert.equal(result.cacheReadTokens, 5);
    assert.equal(result.attempts, 1);
    const [seen] = JSON.parse(readFileSync(record, "utf8")) as Array<{ args: string[]; input: string; cwd: string; env: string[]; tmpExists: boolean }>;
    assert.ok(seen !== undefined);
    // macOS adds __CF_USER_TEXT_ENCODING to every new process itself; nothing else may appear.
    assert.deepEqual(seen.env.filter((name) => name !== "__CF_USER_TEXT_ENCODING"), ["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "DISABLE_AUTOUPDATER", "HOME", "LANG", "PATH", "TMPDIR"]);
    assert.equal(seen.input, "PROMPT TEXT");
    assert.equal(realpathSync(seen.cwd), treeDir);
    assert.equal(seen.tmpExists, true);
    assert.ok(!seen.args.includes("--fallback-model"));
    // The settings and MCP config are written fresh per session; the scratch directory is gone.
    const sessionDir = join(home, "runs", "run1", "sessions", "security-s0");
    const settings = JSON.parse(readFileSync(join(sessionDir, "settings.json"), "utf8")) as { model: string; permissions: { deny: string[] } };
    assert.equal(settings.model, MODELS.opus);
    assert.deepEqual(JSON.parse(readFileSync(join(sessionDir, "mcp.json"), "utf8")), { mcpServers: {} });
    assert.equal(seen.args[seen.args.indexOf("--settings") + 1], join(sessionDir, "settings.json"));
    assert.deepEqual(readdirSync(join(home, "scratch")), []);
  });

  it("under the pool transport, sees exactly the fixed names and the three pool variables, and records the forwarder as its API host", async () => {
    writeFileSync(record, "[]");
    const engineEnv = {
      HOME: userHome,
      PATH: process.env["PATH"] ?? "",
      FIN_REVIEW_TRANSPORT: "pool",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/",
      ANTHROPIC_AUTH_TOKEN: "pool-token-value",
      CLAUDE_CONFIG_DIR: join(userHome, "pool-config"),
      GITHUB_TOKEN: "x",
    };
    const resolved = resolveTransport(engineEnv);
    assert.ok(resolved.ok);
    const treeDir = join(home, "trees", "run1");
    const result = await runner(engineEnv, undefined, resolved.value).run(spec({ id: "pool-s0", treeDir, schema: SCHEMA }), new AbortController().signal);
    assert.equal(result.state, "ok", result.failureDetail ?? "");
    assert.equal(result.apiHost, "127.0.0.1:41234");
    const [seen] = JSON.parse(readFileSync(record, "utf8")) as Array<{ env: string[] }>;
    assert.deepEqual(seen?.env.filter((name) => name !== "__CF_USER_TEXT_ENCODING"), [...POOL_SESSION_ENV_NAMES].sort());
  });

  it("under the pool transport, a model other than the requested one in modelUsage is still refused, with no retry", async () => {
    writeFileSync(record, "[]");
    const engineEnv = { HOME: userHome, FIN_REVIEW_TRANSPORT: "pool", ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CONFIG_DIR: join(userHome, "pool-config") };
    const resolved = resolveTransport(engineEnv);
    assert.ok(resolved.ok);
    const treeDir = join(home, "trees", "run1");
    // With MISMATCH in the prompt the fake reports a second model in modelUsage, as a forwarder that
    // served another model would.
    const result = await runner(engineEnv, undefined, resolved.value).run(spec({ id: "pool-mismatch-s0", treeDir, schema: SCHEMA, prompt: "MISMATCH" }), new AbortController().signal);
    assert.equal(result.state, "failed");
    assert.equal(result.failure, "model_mismatch");
    assert.equal(result.attempts, 1, "a mismatch is never retried");
    assert.deepEqual([...result.modelObserved].sort(), [MODELS.opus, "claude-haiku-9-9"].sort());
  });

  it("times out, retries once in a fresh scratch home, then fails as timeout", async () => {
    writeFileSync(record, "[]");
    const treeDir = join(home, "trees", "run1");
    const result = await runner({ HOME: userHome }).run(spec({ id: "slow-s0", treeDir, prompt: "SLEEP", timeoutMs: 400 }), new AbortController().signal);
    assert.equal(result.state, "failed");
    assert.equal(result.failure, "timeout");
    assert.equal(result.attempts, 2);
    const seen = JSON.parse(readFileSync(record, "utf8")) as Array<{ env: string[] }>;
    assert.equal(seen.length, 2);
    assert.deepEqual(readdirSync(join(home, "scratch")), []);
  });

  it("refuses a session ID it would not place in a path, and a tree outside FIN_REVIEW_HOME", async () => {
    await assert.rejects(runner({ HOME: userHome }).run(spec({ id: "../x" }), new AbortController().signal), TypeError);
    await assert.rejects(runner({ HOME: userHome }).run(spec({ treeDir: "/tmp" }), new AbortController().signal), TypeError);
  });

  it("starts no attempt once the pinned file is no longer the one whose version was checked", async () => {
    writeFileSync(record, "[]");
    const treeDir = join(home, "trees", "run1");
    const result = await runner({ HOME: userHome }, "0:0:0:0:0").run(spec({ id: "swapped-s0", treeDir, schema: SCHEMA }), new AbortController().signal);
    assert.equal(result.state, "failed");
    assert.equal(result.failure, "exit");
    assert.match(result.failureDetail ?? "", /the pinned Claude Code changed during the run/);
    assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), [], "the program was never started");
  });

  it("pins the file a link names: a re-pointed link does not change the file a run starts", () => {
    const versions = join(userHome, "versions");
    mkdirSync(versions, { recursive: true });
    writeFileSync(join(versions, "9.9.1"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(versions, "9.9.2"), "#!/bin/sh\n", { mode: 0o755 });
    const link = join(userHome, "bin", "claude-link");
    symlinkSync(join(versions, "9.9.1"), link);
    const pinned = pinClient(link);
    assert.equal(pinned.path, join(versions, "9.9.1"));
    rmSync(link);
    symlinkSync(join(versions, "9.9.2"), link);
    assert.equal(clientFingerprint(pinned.path), pinned.fingerprint, "the pinned file itself is unchanged");
    writeFileSync(join(versions, "9.9.1"), "#!/bin/sh\necho rewritten\n", { mode: 0o755 });
    assert.notEqual(clientFingerprint(pinned.path), pinned.fingerprint, "a rewrite is seen");
    assert.throws(() => pinClient(join(userHome, "bin", "no-such-claude")), /claudePath does not name a file that exists/);
  });
});
