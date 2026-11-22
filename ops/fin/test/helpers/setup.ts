// A command run against the provider fakes, with every leak check in one place.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli } from "../../src/cli.ts";
import { loadSettings } from "../../src/core/settings.ts";
import {
  commandEnv,
  type FakeRuntime,
  fakeRuntime,
  fakeToken,
  privateValues,
  REPO_ROOT,
  writePrivate,
} from "./fixtures.ts";
import { FakeCloudflare, FakeRailway, providers } from "./providers.ts";

export interface Harness {
  cf: FakeCloudflare;
  rw: FakeRailway;
  /** Every provider call across both fakes, in order. */
  sequence: string[];
  runtime: FakeRuntime;
  dir: string;
  env: Record<string, string>;
  run(argv: string[]): Promise<number>;
  /** Everything the run wrote anywhere a person or a log could read. */
  readable(): string;
  /** Asserts that nothing readable holds a private value or any of the given secrets. */
  assertNoLeak(secrets?: readonly string[]): void;
  records(): Array<Record<string, unknown>>;
  /** The telemetry lines kept beside the run log (lines.jsonl), in order. */
  lines(): Array<Record<string, unknown>>;
}

/** One JSON record per line. */
function parsed(text: string): Array<Record<string, unknown>> {
  return text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * A harness with the fixture overlay and staging's public settings, each changed first by the
 * optional callback (the settings change goes into a copy of the repository's environment file).
 */
export function harness(
  overlayChange?: (o: Record<string, unknown>) => void,
  settingsChange?: (s: Record<string, unknown>) => void,
): Harness {
  const { env, dir } = commandEnv();
  if (overlayChange !== undefined) {
    const overlay = JSON.parse(readFileSync(env.FIN_OVERLAY_FILE ?? "", "utf8")) as Record<
      string,
      unknown
    >;
    overlayChange(overlay);
    env.FIN_OVERLAY_FILE = writePrivate(dir, "overlay2.json", JSON.stringify(overlay));
  }
  const cfToken = fakeToken("cf");
  const rwToken = fakeToken("rw");
  env.FIN_CF_TOKEN_FILE = writePrivate(dir, "cf-token", cfToken);
  env.FIN_RAILWAY_TOKEN_FILE = writePrivate(dir, "railway-token", rwToken);
  let repoRoot = REPO_ROOT;
  if (settingsChange !== undefined) {
    const file = join("ops", "environments", "staging.json");
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, file), "utf8")) as Record<string, unknown>;
    settingsChange(raw);
    repoRoot = join(dir, "repo");
    mkdirSync(join(repoRoot, "ops", "environments"), { recursive: true });
    writeFileSync(join(repoRoot, file), JSON.stringify(raw));
  }
  const settings = loadSettings(repoRoot, "staging");
  const cf = new FakeCloudflare(cfToken);
  const rw = new FakeRailway(rwToken, Object.keys(settings.railway.services));
  const sequence: string[] = [];
  const runtime = fakeRuntime({ env, fetch: providers(cf, rw, sequence), repoRoot });
  const stateDir = join(env.FIN_STATE_DIR ?? "", "staging");
  const read = (name: string) =>
    existsSync(join(stateDir, name)) ? readFileSync(join(stateDir, name), "utf8") : "";
  const h: Harness = {
    cf,
    rw,
    sequence,
    runtime,
    dir,
    env,
    run: (argv) => runCli(argv, runtime),
    readable: () =>
      [
        runtime.out(),
        runtime.err(),
        read("runs.jsonl"),
        read("lines.jsonl"),
        read("lock.json"),
      ].join("\n"),
    assertNoLeak: (secrets = []) => {
      const text = h.readable();
      for (const value of [...privateValues(), cfToken, rwToken, ...secrets]) {
        assert.equal(
          text.toLowerCase().includes(value.toLowerCase()),
          false,
          `leaked a private value: ${value.slice(0, 4)}...`,
        );
      }
    },
    records: () => parsed(read("runs.jsonl")),
    lines: () => parsed(read("lines.jsonl")),
  };
  return h;
}
