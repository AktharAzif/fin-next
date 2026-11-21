// The transport (decision BD-22): direct by default; pool, opt-in, accepts exactly a loopback
// forwarder's base URL, its token and its configuration folder, passes exactly those into each
// session, and still refuses every other endpoint, model, effort and credential variable.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadEngineConfig } from "../src/config.ts";
import { POOL_SESSION_ENV_NAMES, SESSION_ENV_NAMES, environmentRefusals, sessionEnv } from "../src/runner/env.ts";
import { apiHostOf } from "../src/runner/cli.ts";
import { DIRECT, poolUrlProblem, resolveTransport } from "../src/transport.ts";
import type { Transport } from "../src/transport.ts";
import { CONFIG_DIR } from "./helpers/cli.ts";

const loaded = loadEngineConfig(CONFIG_DIR);
if (!loaded.ok) throw new Error("config");
const REFUSALS = loaded.value.envRefusals;

const POOL_ENV = {
  HOME: "/h",
  PATH: "/usr/bin:/bin",
  FIN_REVIEW_TRANSPORT: "pool",
  ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/",
  ANTHROPIC_AUTH_TOKEN: "pool-token-value",
  CLAUDE_CONFIG_DIR: "/h/.pool-config",
};

function pool(env: Record<string, string> = POOL_ENV): Transport {
  const resolved = resolveTransport(env);
  assert.ok(resolved.ok, resolved.ok ? "" : resolved.errors.join("; "));
  return resolved.value;
}

describe("the transport (BD-22)", () => {
  it("is direct unless FIN_REVIEW_TRANSPORT says pool, and refuses any other value", () => {
    assert.deepEqual(resolveTransport({}), { ok: true, value: DIRECT });
    assert.deepEqual(resolveTransport({ FIN_REVIEW_TRANSPORT: "direct" }), { ok: true, value: DIRECT });
    assert.equal(resolveTransport({ FIN_REVIEW_TRANSPORT: "gateway" }).ok, false);
    assert.equal(resolveTransport({ fin_review_transport: "pool" }).ok, false, "only the exact name counts");
    assert.equal(pool().kind, "pool");
  });

  it("under pool, accepts only http or https to 127.0.0.1, [::1] or localhost with an explicit port and no path", () => {
    for (const url of ["http://127.0.0.1:41234/", "http://127.0.0.1:41234", "https://localhost:8443/", "http://[::1]:9000/"]) assert.equal(poolUrlProblem(url), null, url);
    for (const url of [
      "https://api.example.com:443/",
      "http://127.0.0.1/",
      "http://127.0.0.1:0/",
      "http://127.0.0.1:70000/",
      "http://127.0.0.1:41234/v1",
      "http://127.0.0.1:41234/?x=1",
      "http://127.0.0.1:41234/#f",
      "http://user@127.0.0.1:41234/",
      "http://127.0.0.2:41234/",
      "http://localhost.example.com:41234/",
      "http://127.0.0.1.nip.io:41234/",
      "ftp://127.0.0.1:41234/",
      "http://0x7f000001:41234/",
    ]) {
      assert.notEqual(poolUrlProblem(url), null, url);
      const resolved = resolveTransport({ ...POOL_ENV, ANTHROPIC_BASE_URL: url });
      assert.equal(resolved.ok, false, url);
    }
  });

  it("under pool, needs all three variables, an absolute configuration folder, a token, and no second credential", () => {
    for (const name of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CONFIG_DIR"]) {
      const env: Record<string, string> = { ...POOL_ENV };
      delete env[name];
      const resolved = resolveTransport(env);
      assert.ok(!resolved.ok && resolved.errors.some((error) => error.includes(name)), name);
    }
    assert.equal(resolveTransport({ ...POOL_ENV, CLAUDE_CONFIG_DIR: "relative" }).ok, false);
    assert.equal(resolveTransport({ ...POOL_ENV, CLAUDE_CONFIG_DIR: "/h/../etc" }).ok, false);
    assert.equal(resolveTransport({ ...POOL_ENV, ANTHROPIC_AUTH_TOKEN: "a b" }).ok, false);
    const both = resolveTransport({ ...POOL_ENV, CLAUDE_CODE_OAUTH_TOKEN: "sk-x" });
    assert.ok(!both.ok && both.errors.some((error) => error.includes("CLAUDE_CODE_OAUTH_TOKEN")));
    // Errors never hold a value.
    const bad = resolveTransport({ ...POOL_ENV, ANTHROPIC_BASE_URL: "https://secret-host.example.com/" });
    assert.ok(!bad.ok && !bad.errors.join(" ").includes("secret-host"));
  });

  it("under pool, the refusals pass only the three pool variables: every model, effort, provider and other credential is still refused", () => {
    assert.deepEqual(environmentRefusals(POOL_ENV, REFUSALS, pool()), []);
    // Direct refuses the same three.
    assert.deepEqual(environmentRefusals(POOL_ENV, REFUSALS, DIRECT).map((item) => item.name), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR"]);
    const extra = {
      ...POOL_ENV,
      ANTHROPIC_MODEL: "x",
      CLAUDE_EFFORT: "low",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "k",
      HTTPS_PROXY: "http://example.com",
      MAX_THINKING_TOKENS: "1",
      CLAUDE_CODE_EXTRA_BODY: "{}",
      anthropic_base_url: "http://127.0.0.1:41234/",
    };
    assert.deepEqual(
      environmentRefusals(extra, REFUSALS, pool()).map((item) => item.name).sort(),
      ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDE_CODE_EXTRA_BODY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_EFFORT", "HTTPS_PROXY", "MAX_THINKING_TOKENS", "anthropic_base_url"].sort(),
    );
  });

  it("under pool, a session's environment holds exactly the fixed names and the three pool variables; under direct, nothing changes", () => {
    const env = sessionEnv({ ...POOL_ENV, GITHUB_TOKEN: "x", NODE_OPTIONS: "--require=/x.js", CLAUDE_CODE_OAUTH_TOKEN: "ignored" }, "/h/.fin-review/scratch/s/tmp", pool());
    assert.deepEqual(env, {
      PATH: "/usr/bin:/bin",
      HOME: "/h",
      LANG: "C.UTF-8",
      TMPDIR: "/h/.fin-review/scratch/s/tmp",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:41234/",
      ANTHROPIC_AUTH_TOKEN: "pool-token-value",
      CLAUDE_CONFIG_DIR: "/h/.pool-config",
    });
    assert.deepEqual(Object.keys(env).sort(), [...POOL_SESSION_ENV_NAMES].sort());
    assert.ok(!Object.keys(env).includes("CLAUDE_CODE_OAUTH_TOKEN"), "one credential: the pool's");
    const direct = sessionEnv({ HOME: "/h" }, "/t");
    for (const name of Object.keys(direct)) assert.ok(SESSION_ENV_NAMES.includes(name));
    assert.throws(() => sessionEnv(POOL_ENV, "/t"), /CLAUDE_CONFIG_DIR/, "direct still refuses a configuration folder");
    assert.equal(apiHostOf(pool()), "127.0.0.1:41234");
    assert.equal(apiHostOf(DIRECT), "api.anthropic.com");
  });
});
