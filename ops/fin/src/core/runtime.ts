// What a run gets from the outside world, injected so tests replace every part (AGENTS.md §2: no
// module-scope clock, randomness or connection). main.ts builds the real one.

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Env } from "./credentials.ts";

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The signals that stop a run: Ctrl-C, and a polite kill (a CI cancel, a closed terminal). */
export type InterruptSignal = "SIGINT" | "SIGTERM";

/** The exit code a run ends with when a signal stopped it (128 + the signal's number). */
export const INTERRUPT_EXIT: Readonly<Record<InterruptSignal, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
};

/** How long the clean-up after an interrupt may take before the process exits anyway. */
export const INTERRUPT_DEADLINE_MS = 5_000;

export interface Runtime {
  readonly env: Env;
  /** The repository's root (ops/environments, docs/runbooks and the apps live under it). */
  readonly repoRoot: string;
  readonly now: () => Date;
  readonly random: (bytes: number) => Uint8Array;
  readonly fetch: FetchFn;
  readonly sleep: (ms: number) => Promise<void>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The OS user running the command (written to the local run log only). */
  readonly operator: () => string;
  /** The commit the running code came from, or undefined outside a git checkout. */
  readonly commit: () => string | undefined;
  /**
   * Whether the checkout has local changes (tracked or untracked files that differ from the
   * commit), so the commit alone does not say what ran; undefined outside a git checkout.
   */
  readonly dirty: () => boolean | undefined;
  /** Runs a program with arguments (no shell) and returns its exit status and output. */
  readonly exec: (program: string, args: readonly string[]) => ExecResult;
  /**
   * Calls the handler when SIGINT or SIGTERM arrives, until the returned function is called. The
   * real runtime then exits with INTERRUPT_EXIT once the handler has settled, or after
   * INTERRUPT_DEADLINE_MS; a second signal exits at once.
   */
  readonly trap: (handler: (signal: InterruptSignal) => Promise<void>) => () => void;
}

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** The directory that holds the local run log and the run lock (until the R2 vault exists). */
export function stateDir(env: Env): string {
  const explicit = env.FIN_STATE_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;
  const base = env.XDG_STATE_HOME;
  return join(
    base !== undefined && base !== "" ? base : join(homedir(), ".local", "state"),
    "fin-next",
  );
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** The real runtime, for main.ts. */
export function processRuntime(repoRoot: string): Runtime {
  return {
    env: process.env,
    repoRoot,
    now: () => new Date(),
    random: (bytes) => new Uint8Array(randomBytes(bytes)),
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    operator: () => {
      try {
        return userInfo().username;
      } catch {
        return "unknown";
      }
    },
    commit: () => {
      try {
        const sha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined;
      } catch {
        return undefined;
      }
    },
    dirty: () => {
      try {
        return git(repoRoot, ["status", "--porcelain", "--untracked-files=normal"]).trim() !== "";
      } catch {
        return undefined;
      }
    },
    exec: (program, args) => {
      try {
        const stdout = execFileSync(program, [...args], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        });
        return { status: 0, stdout, stderr: "" };
      } catch (error) {
        const e = error as { status?: number | null; stdout?: string; stderr?: string };
        return { status: e.status ?? null, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    },
    trap: (handler) => {
      let closing = false;
      const on = (received: NodeJS.Signals) => {
        const signal: InterruptSignal = received === "SIGTERM" ? "SIGTERM" : "SIGINT";
        const code = INTERRUPT_EXIT[signal];
        // A second signal while the run is being closed: the operator insists.
        if (closing) process.exit(code);
        closing = true;
        const deadline = new Promise<void>((resolve) => {
          setTimeout(resolve, INTERRUPT_DEADLINE_MS).unref();
        });
        Promise.race([handler(signal).catch(() => undefined), deadline]).finally(() =>
          process.exit(code),
        );
      };
      process.on("SIGINT", on);
      process.on("SIGTERM", on);
      return () => {
        process.off("SIGINT", on);
        process.off("SIGTERM", on);
      };
    },
  };
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** A sortable run ID, `run_` and 26 Crockford base32 characters (spec 08 §7.2's `run_...`). */
export function newRunId(runtime: Pick<Runtime, "now" | "random">): string {
  let time = runtime.now().getTime();
  let head = "";
  for (let i = 0; i < 10; i++) {
    head = (CROCKFORD[time % 32] ?? "0") + head;
    time = Math.floor(time / 32);
  }
  const bytes = runtime.random(16);
  let tail = "";
  for (let i = 0; i < 16; i++) tail += CROCKFORD[(bytes[i] ?? 0) % 32];
  return `run_${head}${tail}`;
}
