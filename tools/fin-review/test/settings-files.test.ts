// The settings and configuration files a locked session could read (spec 07 §4.3's second half):
// the user settings, the global configuration and its legacy file, cached server-managed settings,
// the managed settings files, macOS's managed-preferences plists, and the platforms whose policy
// sources cannot be checked.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadEngineConfig } from "../src/config.ts";
import type { EnvRefusals } from "../src/env-refusals.ts";
import { settingsRefusals, settingsSources } from "../src/runner/settings-files.ts";
import type { PlistConversion, SettingsSources, SourceOverrides } from "../src/runner/settings-files.ts";
import { DIRECT, resolveTransport } from "../src/transport.ts";
import type { Transport } from "../src/transport.ts";
import { CONFIG_DIR } from "./helpers/cli.ts";
import { tempDir } from "./helpers/git-fixture.ts";

const loaded = loadEngineConfig(CONFIG_DIR);
if (!loaded.ok) throw new Error("config");
const REFUSALS: EnvRefusals = loaded.value.envRefusals;

describe("settings and configuration files (spec 07 §4.3)", () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let base: SourceOverrides;
  before(() => {
    tmp = tempDir("settings-files");
    home = join(tmp.dir, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    base = { managedSettingsDir: join(tmp.dir, "managed"), managedPreferencesDir: join(tmp.dir, "prefs"), platform: "darwin" };
  });
  after(() => tmp.cleanup());

  const sources = (transport: Transport = DIRECT, overrides: SourceOverrides = {}): SettingsSources => settingsSources(home, transport, { ...base, ...overrides });
  const problems = async (s: SettingsSources): Promise<string[]> => (await settingsRefusals(s, REFUSALS)).map((item) => `${item.file.slice(tmp.dir.length)}: ${item.problem}`);

  it("a clean machine passes", async () => {
    assert.deepEqual(await problems(sources()), []);
  });

  it("refuses an env block or a refused key in the global configuration, $HOME/.claude.json, and its legacy file", async () => {
    const global = join(home, ".claude.json");
    // The client's own state is not held to the settings allowlist.
    writeFileSync(global, JSON.stringify({ numStartups: 4, projects: {}, userID: "x", env: {} }));
    assert.deepEqual(await problems(sources()), []);
    writeFileSync(global, JSON.stringify({ numStartups: 4, env: { CLAUDE_CODE_USE_BEDROCK: "1", HTTPS_PROXY: "http://example.com" }, model: "x" }));
    assert.deepEqual(await problems(sources()), ["/home/.claude.json: sets refused keys: env.CLAUDE_CODE_USE_BEDROCK, env.HTTPS_PROXY, model"]);
    writeFileSync(global, "{ not json");
    assert.match((await problems(sources()))[0] ?? "", /^\/home\/\.claude\.json: not valid JSON/);
    writeFileSync(global, "[]");
    assert.deepEqual(await problems(sources()), ["/home/.claude.json: is not a JSON object"]);
    writeFileSync(global, "{}");
    writeFileSync(join(home, ".claude", ".config.json"), JSON.stringify({ env: { ANTHROPIC_MODEL: "x" } }));
    assert.deepEqual(await problems(sources()), ["/home/.claude/.config.json: sets refused keys: env.ANTHROPIC_MODEL"]);
    writeFileSync(join(home, ".claude", ".config.json"), "{}");
  });

  it("refuses cached server-managed settings, which cannot be checked", async () => {
    writeFileSync(join(home, ".claude", "remote-settings.json"), "{}");
    try {
      assert.deepEqual(await problems(sources()), ["/home/.claude/remote-settings.json: holds cached server-managed settings, which cannot be checked"]);
    } finally {

      rmSync(join(home, ".claude", "remote-settings.json"));
    }
  });

  it("on macOS, checks both managed-preferences plists through the converter, and fails closed when one cannot be converted", async () => {
    const prefs = join(tmp.dir, "prefs");
    const user = sources().user;
    assert.ok(user !== null);
    mkdirSync(join(prefs, user), { recursive: true });
    const device = join(prefs, "com.anthropic.claudecode.plist");
    const perUser = join(prefs, user, "com.anthropic.claudecode.plist");
    writeFileSync(device, "plist bytes");
    writeFileSync(perUser, "plist bytes");
    const converted: string[] = [];
    const convert = (answers: Record<string, PlistConversion>) => async (file: string): Promise<PlistConversion> => {
      converted.push(file);
      return answers[file] ?? { ok: true, json: Buffer.from("{}") };
    };
    assert.deepEqual(await problems(sources(DIRECT, { convertPlist: convert({}) })), []);
    assert.deepEqual(converted.sort(), [device, perUser].sort(), "both plists were read");
    const set = await problems(
      sources(DIRECT, {
        convertPlist: convert({
          [device]: { ok: true, json: Buffer.from(JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://example.com" }, availableModels: ["x"] })) },
          [perUser]: { ok: false, error: "plutil could not convert it (exit 1)" },
        }),
      }),
    );
    assert.deepEqual(set.sort(), [
      `/prefs/${user}/com.anthropic.claudecode.plist: plutil could not convert it (exit 1)`,
      "/prefs/com.anthropic.claudecode.plist: sets refused keys: env.ANTHROPIC_BASE_URL, availableModels",
    ]);
    // Elsewhere than macOS no plist is read.
    converted.length = 0;
    assert.deepEqual(await problems(sources(DIRECT, { platform: "linux", wslMarker: join(tmp.dir, "no-reg.exe"), convertPlist: convert({}) })), []);
    assert.deepEqual(converted, []);
    rmSync(prefs, { recursive: true, force: true });
  });

  it("refuses to run where the client reads policy sources the engine cannot: Windows, and Linux under WSL", async () => {
    const windows = await settingsRefusals(sources(DIRECT, { platform: "win32" }), REFUSALS);
    assert.ok(
      windows.some((item) => item.file === "HKLM and HKCU\\SOFTWARE\\Policies\\ClaudeCode" && /the managed policy keys the client reads on Windows cannot be checked/.test(item.problem)),
      JSON.stringify(windows),
    );
    const marker = join(tmp.dir, "reg.exe");
    writeFileSync(marker, "");
    assert.deepEqual(await problems(sources(DIRECT, { platform: "linux", wslMarker: marker })), ["/reg.exe: under WSL the client also reads the Windows side's managed settings and policy keys, which cannot be checked"]);
  });

  it("under the pool transport, reads the forwarder's configuration folder, and its user settings may carry only the pool's own login", async () => {
    const configDir = join(tmp.dir, "pool-config");
    mkdirSync(configDir, { recursive: true });
    const resolved = resolveTransport({ FIN_REVIEW_TRANSPORT: "pool", ANTHROPIC_BASE_URL: "http://127.0.0.1:4100/", ANTHROPIC_AUTH_TOKEN: "pool-token", CLAUDE_CONFIG_DIR: configDir });
    assert.ok(resolved.ok);
    const pool = resolved.value;
    // $HOME/.claude's settings are not the session's under pool.
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "x", effortLevel: "low" }));
    try {
      writeFileSync(join(configDir, "settings.json"), JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4100/", ANTHROPIC_AUTH_TOKEN: "pool-token" } }));
      assert.deepEqual(await problems(sources(pool)), []);
      assert.match((await problems(sources(DIRECT))).join("\n"), /\/home\/\.claude\/settings\.json: sets refused keys: model, effortLevel/);
      // Another value, or another variable, is refused, by name only.
      writeFileSync(join(configDir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4999/", ANTHROPIC_AUTH_TOKEN: "pool-token", ANTHROPIC_MODEL: "x" } }));
      const refused = await problems(sources(pool));
      assert.deepEqual(refused, ["/pool-config/settings.json: sets refused keys: env.ANTHROPIC_BASE_URL, env.ANTHROPIC_MODEL"]);
      assert.ok(!refused.join("").includes("pool-token"));
      // The global configuration is the forwarder folder's .claude.json.
      writeFileSync(join(configDir, "settings.json"), "{}");
      writeFileSync(join(configDir, ".claude.json"), JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: "{}" } }));
      assert.deepEqual(await problems(sources(pool)), ["/pool-config/.claude.json: sets refused keys: env.CLAUDE_CODE_EXTRA_BODY"]);
    } finally {
      writeFileSync(join(home, ".claude", "settings.json"), "{}");
    }
  });
});
