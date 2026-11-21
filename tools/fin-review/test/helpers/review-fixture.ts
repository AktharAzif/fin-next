// A fixture for the review modes: an "origin" repository with `main` and pull request refs, a local
// clone-like repository whose origin is it, a $FIN_REVIEW_HOME and a HOME, all in a temporary
// directory; plus a frozen clock and fake-session helpers. No network.

import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, RandomSource } from "../../src/clock.ts";
import type { PullFacts } from "../../src/gh.ts";
import type { SessionSpec } from "../../src/runner/types.ts";
import { runCli } from "../../src/cli.ts";
import type { ReviewServices } from "../../src/review/commands.ts";
import type { DoctorServices } from "../../src/doctor.ts";
import { CONFIG_DIR } from "./cli.ts";
import { FixtureRepo, tempDir } from "./git-fixture.ts";
import type { FileChanges } from "./git-fixture.ts";
import { fixtureLayout } from "./monorepo.ts";

export interface FakeClock extends Clock {
  readonly sleeps: number[];
  advance(ms: number): void;
}

/** A clock that only moves when told to, recording every wait. */
export function fakeClock(start = Date.UTC(2026, 10, 21, 10, 0, 0)): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** Distinct, repeatable random bytes. */
export function countingRandom(): RandomSource {
  let n = 0;
  return (bytes: number) => {
    n++;
    const out = Buffer.alloc(bytes);
    out.writeUInt32BE(n >>> 0, Math.max(0, bytes - 4));
    return out;
  };
}

function manifest(name: string, deps: Record<string, string> = {}, exportsField?: string): string {
  const out: Record<string, unknown> = { name, private: true, type: "module" };
  if (exportsField !== undefined) out["exports"] = exportsField;
  if (Object.keys(deps).length > 0) out["dependencies"] = deps;
  return `${JSON.stringify(out, null, 2)}\n`;
}

/** The base commit's files. */
export function baseFiles(): Record<string, string> {
  return {
    "package.json": manifest("fin-next"),
    "README.md": "# fin-next\n",
    "tools/layout.json": fixtureLayout(),
    "docs/plan/README.md": "# plan\n\nThe plan.\n",
    "packages/crypto/package.json": manifest("@fin/crypto", {}, "./src/index.ts"),
    "packages/crypto/src/index.ts": [
      "// Comparing secrets.",
      "export function sameSecret(a: string, b: string): boolean {",
      "  return a === b;",
      "}",
      "",
      "export const VERSION = 1;",
      "",
    ].join("\n"),
    "packages/crypto/src/index.test.ts": 'import { sameSecret } from "./index.ts";\n\nexport const ok = sameSecret("a", "a");\n',
    "packages/core/package.json": manifest("@fin/core", { "@fin/crypto": "workspace:*" }, "./src/use.ts"),
    "packages/core/src/use.ts": 'import { sameSecret } from "@fin/crypto";\n\nexport const check = (x: string) => sameSecret(x, "k");\n',
    "packages/ui/package.json": manifest("@fin/ui", {}, "./src/button.ts"),
    "packages/ui/src/button.ts": "export const button = 1;\n",
  };
}

export interface ReviewFixture {
  readonly dir: string;
  readonly origin: FixtureRepo;
  readonly local: FixtureRepo;
  readonly home: string;
  readonly userHome: string;
  readonly base: string;
  readonly env: Record<string, string>;
  /** Commits `changes` on `parent` (default: the base) and points refs/pull/<n>/head at it. */
  pr(n: number, changes: FileChanges, parent?: string): string;
  facts(n: number): Promise<PullFacts>;
  cleanup(): void;
}

export function reviewFixture(): ReviewFixture {
  const tmp = tempDir("review");
  mkdirSync(join(tmp.dir, "origin"), { recursive: true });
  const origin = new FixtureRepo(join(tmp.dir, "origin"));
  const base = origin.commit(null, baseFiles(), "base");
  origin.git(["update-ref", "refs/heads/main", base]);
  mkdirSync(join(tmp.dir, "local"), { recursive: true });
  const local = new FixtureRepo(join(tmp.dir, "local"));
  local.git(["remote", "add", "origin", origin.dir]);
  const home = join(tmp.dir, "fin-review-home");
  const userHome = join(tmp.dir, "user-home");
  mkdirSync(userHome, { recursive: true });
  const env = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: userHome, FIN_REVIEW_HOME: home };
  return {
    dir: tmp.dir,
    origin,
    local,
    home,
    userHome,
    base,
    env,
    pr: (n, changes, parent = base) => {
      const head = origin.commit(parent, changes, `pr ${n}`);
      origin.git(["update-ref", `refs/pull/${n}/head`, head]);
      return head;
    },
    facts: async (n) => ({
      head: origin.git(["rev-parse", `refs/pull/${n}/head`]).trim(),
      baseRef: "main",
      baseSha: base,
      state: "open",
      sameRepository: true,
    }),
    cleanup: tmp.cleanup,
  };
}

// ---- Fake session outputs -----------------------------------------------------------------------

/** The checklist item IDs a session's schema allows. */
export function itemIds(spec: SessionSpec): string[] {
  const schema = spec.schema as { properties: { checked: { items: { properties: { item: { enum: string[] } } } } } };
  return [...schema.properties.checked.items.properties.item.enum];
}

/** A clean lens output: every item ok, no findings. */
export function cleanOutput(spec: SessionSpec, findings: unknown[] = []): Record<string, unknown> {
  return { done: true, checked: itemIds(spec).map((item) => ({ item, verdict: findings.length > 0 ? "finding" : "ok" })), findings, procedureGaps: [] };
}

/** A finding for `spec`'s lens that cites packages/crypto/src/index.ts correctly. */
export function cryptoFinding(spec: SessionSpec, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lens: spec.lens,
    ...(spec.profile === undefined ? {} : { profile: spec.profile }),
    class: "unclassified",
    severity: "medium",
    title: "Secrets compared with ===",
    where: [{ path: "packages/crypto/src/index.ts", startLine: 1, endLine: 3 }],
    quotes: [{ path: "packages/crypto/src/index.ts", text: "return a === b;" }],
    claim: "The comparison is not constant-time.",
    scenario: "An attacker times the comparison byte by byte.",
    testShouldFail: "A timing test of sameSecret.",
    preExisting: false,
    ...overrides,
  };
}

export interface RunOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the CLI in-process with the fixture's environment and `services`. */
export async function runFixtureCli(fx: ReviewFixture, argv: string[], services: ReviewServices & DoctorServices, env: Record<string, string> = fx.env): Promise<RunOutput> {
  let stdout = "";
  let stderr = "";
  const code = await runCli({
    argv,
    env,
    cwd: fx.local.dir,
    configDir: CONFIG_DIR,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    services,
  });
  return { code, stdout, stderr };
}

/** The run directories under $FIN_REVIEW_HOME/runs, oldest first (by the counting random suffix). */
export function runDirs(home: string): string[] {
  const suffix = (name: string): string => name.slice(name.lastIndexOf("-") + 1);
  try {
    return readdirSync(join(home, "runs"))
      .sort((a, b) => (suffix(a) < suffix(b) ? -1 : suffix(a) > suffix(b) ? 1 : 0))
      .map((name) => join(home, "runs", name));
  } catch {
    return [];
  }
}

export function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
