// Builds throwaway git repositories for tests with `git fast-import`, so a 2,000-file tree is
// written in one call and no work tree, hook or user configuration is involved.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** File contents by path; null deletes the path. */
export type FileChanges = Readonly<Record<string, string | null>>;

/** An environment for git that ignores the machine's own configuration. */
export function fixtureEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || name.toUpperCase().startsWith("GIT_")) continue;
    env[name] = value;
  }
  env["HOME"] = home;
  env["GIT_CONFIG_NOSYSTEM"] = "1";
  env["GIT_CONFIG_GLOBAL"] = "/dev/null";
  env["GIT_TERMINAL_PROMPT"] = "0";
  return env;
}

function runGit(dir: string, args: string[], input?: Buffer): string {
  const result = spawnSync("git", args, {
    cwd: dir,
    env: fixtureEnv(dir),
    input,
    shell: false,
    timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8");
}

/** C-style quoting for a fast-import path, so spaces, quotes and newlines survive. */
function quotePath(path: string): string {
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

export class FixtureRepo {
  readonly dir: string;
  private counter = 0;

  constructor(dir: string) {
    this.dir = dir;
    runGit(dir, ["init", "-q", "--initial-branch=main"]);
  }

  /** Creates a commit on top of `parent` (or a root commit) and returns its SHA. */
  commit(parent: string | null, changes: FileChanges, message = "fixture"): string {
    this.counter++;
    const ref = `refs/heads/fixture-${this.counter}`;
    const chunks: Buffer[] = [];
    const push = (text: string): void => {
      chunks.push(Buffer.from(text, "utf8"));
    };
    const messageBytes = Buffer.from(message, "utf8");
    push(`commit ${ref}\n`);
    push(`committer Fixture <fixture@example.com> ${1763683200 + this.counter} +0000\n`);
    push(`data ${messageBytes.length}\n`);
    chunks.push(messageBytes);
    push("\n");
    if (parent !== null) push(`from ${parent}\n`);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        push(`D ${quotePath(path)}\n`);
        continue;
      }
      const bytes = Buffer.from(content, "utf8");
      push(`M 100644 inline ${quotePath(path)}\n`);
      push(`data ${bytes.length}\n`);
      chunks.push(bytes);
      push("\n");
    }
    push("\n");
    runGit(this.dir, ["fast-import", "--quiet", "--done"], Buffer.concat([...chunks, Buffer.from("done\n")]));
    return runGit(this.dir, ["rev-parse", ref]).trim();
  }

  /** Runs any git command in the repository (for test setup only), with `input` on stdin. */
  git(args: string[], input?: Buffer): string {
    return runGit(this.dir, args, input);
  }
}

/** A fresh temporary directory; call the returned cleanup when done. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `fin-review-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
