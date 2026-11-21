// Builds throwaway git repositories for tests with `git fast-import`, so a 2,000-file tree is
// written in one call and no work tree, hook or user configuration is involved.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A symbolic link to `symlink`, or a submodule entry at commit `gitlink`. */
export type SpecialEntry = { readonly symlink: string } | { readonly gitlink: string };

/** File contents by path; null deletes the path. */
export type FileChanges = Readonly<Record<string, string | null | SpecialEntry>>;

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

/** Runs git in `dir` with the fixture environment (for test setup only). */
export function runGit(dir: string, args: string[], input?: Buffer): string {
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

  /**
   * Creates a commit and returns its SHA. Its tree is the first parent's (empty for a root commit)
   * with `changes` applied; further parents make it a merge commit. Each commit is dated one
   * second after the one before, so later commits are newer.
   */
  commit(
    parents: string | readonly string[] | null,
    changes: FileChanges,
    message = "fixture",
  ): string {
    this.counter++;
    const ref = `refs/heads/fixture-${this.counter}`;
    const chunks: Buffer[] = [];
    const push = (text: string): void => {
      chunks.push(Buffer.from(text, "utf8"));
    };
    const messageBytes = Buffer.from(message, "utf8");
    const list = parents === null ? [] : typeof parents === "string" ? [parents] : [...parents];
    push(`commit ${ref}\n`);
    push(`committer Fixture <fixture@example.com> ${1763683200 + this.counter} +0000\n`);
    push(`data ${messageBytes.length}\n`);
    chunks.push(messageBytes);
    push("\n");
    for (const [index, parent] of list.entries())
      push(`${index === 0 ? "from" : "merge"} ${parent}\n`);
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) {
        push(`D ${quotePath(path)}\n`);
        continue;
      }
      if (typeof content !== "string" && "gitlink" in content) {
        push(`M 160000 ${content.gitlink} ${quotePath(path)}\n`);
        continue;
      }
      const symlink = typeof content !== "string";
      const bytes = Buffer.from(symlink ? content.symlink : content, "utf8");
      push(`M ${symlink ? "120000" : "100644"} inline ${quotePath(path)}\n`);
      push(`data ${bytes.length}\n`);
      chunks.push(bytes);
      push("\n");
    }
    push("\n");
    runGit(
      this.dir,
      ["fast-import", "--quiet", "--done"],
      Buffer.concat([...chunks, Buffer.from("done\n")]),
    );
    return runGit(this.dir, ["rev-parse", ref]).trim();
  }

  /** Runs any git command in the repository (for test setup only). */
  git(args: string[]): string {
    return runGit(this.dir, args);
  }
}

/** A fresh temporary directory; call the returned cleanup when done. */
export function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), `fin-review-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
