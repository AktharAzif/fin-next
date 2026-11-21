// `pr --pr <n>` and `commit --pr <n> --since <sha>`: argument checks (exit 64), the lock-down checks
// (exit 78), then the run (src/review/run.ts). The dispatch has already refused an environment that
// holds a variable of config/env-refusals.json (exit 78, [RV-19]). Order here: every refusal the
// arguments alone cause is printed before anything else is read; then $FIN_REVIEW_HOME, the
// procedure and the pinned Claude Code.

import { isAbsolute, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { CliContext, FlagSpec, Refusal } from "../cli.ts";
import { REVIEW_FLAGS, machineDefaults, optionRefusals, parseArgs, printRefusals, refusal, shown } from "../cli.ts";
import { systemClock, systemRandom } from "../clock.ts";
import type { Clock, RandomSource } from "../clock.ts";
import type { EngineConfig } from "../config.ts";
import { ConfigError, DataError, EXIT } from "../errors.ts";
import { runProgram } from "../exec.ts";
import { isSha } from "../git.ts";
import { pullFacts } from "../gh.ts";
import type { PullFacts } from "../gh.ts";
import { ensureHome, finReviewHome, loadMachineConfig, resolveFuture } from "../home.ts";
import type { MachineConfig } from "../home.ts";
import { parseReviewOptions } from "../options.ts";
import { CliRunner } from "../runner/cli.ts";
import type { CliRunnerOptions } from "../runner/cli.ts";
import { compareVersions, parseVersionOutput } from "../runner/client.ts";
import { engineHome, SESSION_PATH } from "../runner/env.ts";
import { isWithin } from "../runner/settings.ts";
import type { SessionRunner } from "../runner/types.ts";
import { checkEngineCopy } from "./engine-copy.ts";
import type { EngineCopy, EngineCopyInput } from "./engine-copy.ts";
import { loadProcedure } from "./procedure.ts";
import { githubSlug, isPrNumber, originUrl, RemoteError } from "./repo.ts";
import { runReview } from "./run.ts";
import type { Mode } from "./run.ts";

/** What a review command needs from the machine; tests replace any of it. */
export interface ReviewServices {
  readonly clock: Clock;
  readonly random: RandomSource;
  /** The pull request's facts; default: `gh api` on the origin's GitHub repository. */
  readonly facts?: (pr: number) => Promise<PullFacts>;
  /** The session runner; default: the CLI runner. */
  readonly makeRunner?: (options: CliRunnerOptions) => SessionRunner;
  /** `claude --version`'s version; default: run the pinned Claude Code. */
  readonly clientVersion?: (claudePath: string) => Promise<string | null>;
  /** Whether the running engine is the default branch's engine copy; default: compare its checkout with the mirror. */
  readonly engineCopy?: (input: EngineCopyInput) => Promise<EngineCopy>;
}

const VERSION_TIMEOUT_MS = 30_000;

function reviewFlags(mode: Mode): FlagSpec[] {
  return [
    ...REVIEW_FLAGS,
    { flag: "--pr", key: "pr", takesValue: true, review: false },
    { flag: "--repo", key: "repo", takesValue: true, review: false },
    { flag: "--advisory", key: "advisory", takesValue: false, review: false },
    ...(mode === "commit" ? [{ flag: "--since", key: "since", takesValue: true, review: false }] : []),
  ];
}

/** The pinned Claude Code's version from `claude --version`, run with a minimal environment. */
export async function readClientVersion(claudePath: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  try {
    const result = await runProgram(claudePath, ["--version"], {
      cwd: "/",
      env: { PATH: SESSION_PATH, HOME: engineHome(env), LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      timeoutMs: VERSION_TIMEOUT_MS,
      maxOutputBytes: 64 * 1024,
    });
    return result.code === 0 ? parseVersionOutput(result.stdout.toString("utf8")) : null;
  } catch {
    return null;
  }
}

/** The directories a session must never read besides those under $FIN_REVIEW_HOME. */
function extraDenied(env: Readonly<Record<string, string | undefined>>): string[] {
  const out: string[] = [];
  for (const name of ["FIN_REVIEW_SPOOL", "FIN_REVIEW_SHARE"]) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    if (!isAbsolute(value)) throw new ConfigError(`$${name}`, ["must be an absolute path"]);
    out.push(value);
  }
  return out;
}

async function topLevel(dir: string, env: Readonly<Record<string, string | undefined>>): Promise<string | null> {
  try {
    const result = await runProgram("git", ["rev-parse", "--show-toplevel"], { cwd: dir, env: { PATH: env["PATH"] ?? SESSION_PATH, HOME: env["HOME"] ?? "/" }, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
    const path = result.stdout.toString("utf8").trim();
    return result.code === 0 && isAbsolute(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/** Runs `pr` or `commit`. */
export async function runReviewCommand(ctx: CliContext, config: EngineConfig, mode: Mode, tokens: readonly string[], services?: ReviewServices): Promise<number> {
  const args = parseArgs(tokens, reviewFlags(mode));
  const refusals: Refusal[] = [...args.refusals];
  const text = (key: string): string | undefined => {
    const value = args.run.get(key);
    return typeof value === "string" ? value : undefined;
  };
  const prText = text("pr");
  if (prText === undefined) refusals.push(refusal("missing_option", `${mode} needs --pr <number>.`));
  else if (!isPrNumber(prText)) refusals.push(refusal("invalid_value", `--pr must be a pull request number, not ${shown(prText)}.`));
  const since = text("since");
  if (mode === "commit") {
    if (since === undefined) refusals.push(refusal("missing_option", "commit needs --since <sha>, the last reviewed head."));
    else if (!isSha(since)) refusals.push(refusal("invalid_value", `--since must be a 40-character lower-case SHA, not ${shown(since)}.`));
  }
  const advisory = args.run.get("advisory") === true;
  const context = { models: config.models, duplicates: args.reviewDuplicates };
  const first = parseReviewOptions(args.review, "cli", config.defaults, context);
  if (!first.ok) refusals.push(...optionRefusals(first.errors));
  if (refusals.length > 0) return printRefusals(ctx, refusals);
  const parsed = parseReviewOptions(args.review, "cli", machineDefaults(ctx, config), context);
  if (!parsed.ok) return printRefusals(ctx, optionRefusals(parsed.errors));

  const realHome = realpathSync(engineHome(ctx.env));
  const homePath = finReviewHome(ctx.env);
  const engineRoot = resolve(ctx.configDir, "..", "..", "..");
  const procedure = loadProcedure(join(engineRoot, "docs", "review"));
  const repoDir = resolve(ctx.cwd, text("repo") ?? ".");
  const repoTop = await topLevel(repoDir, ctx.env);
  if (repoTop === null) throw new DataError("--repo (or the current directory) is not a git repository");
  // Checked before $FIN_REVIEW_HOME is created, so a refused home leaves nothing behind.
  const intended = resolveFuture(homePath);
  for (const top of [repoTop, realpathSync(engineRoot)]) {
    if (isWithin(top, intended)) throw new ConfigError("$FIN_REVIEW_HOME", ["must not lie inside the repository under review or the engine's repository"]);
  }
  const home = ensureHome(homePath);
  const machine: MachineConfig = loadMachineConfig(home, ctx.env);
  let url: string;
  try {
    url = await originUrl(repoTop, ctx.env);
  } catch (error) {
    if (error instanceof RemoteError) throw new DataError(error.message);
    throw error;
  }
  const clock = services?.clock ?? systemClock;
  const random = services?.random ?? systemRandom;
  const readVersion = services?.clientVersion ?? ((path: string) => readClientVersion(path, ctx.env));
  const clientVersion = await readVersion(machine.claudePath);
  if (clientVersion === null || clientVersion !== config.client.claudeCode || compareVersions(clientVersion, config.client.minimum) < 0) {
    ctx.stderr(
      `fin-review: config: claude at the configured claudePath is ${clientVersion ?? "unreadable"}, not the pinned ${config.client.claudeCode} (config/client.json); run doctor\n`,
    );
    return EXIT.config;
  }
  let facts = services?.facts;
  if (facts === undefined) {
    const slug = githubSlug(url);
    if (slug === null) throw new DataError("the origin is not a GitHub repository, so its pull requests cannot be read");
    facts = (pr: number) => pullFacts(slug, pr, home, ctx.env);
  }
  const denied = extraDenied(ctx.env);
  const makeRunner = services?.makeRunner ?? ((options: CliRunnerOptions) => new CliRunner(options));
  return runReview(
    { mode, pr: Number(prText), since: since ?? null, options: parsed.value, advisory },
    {
      config,
      procedure,
      env: ctx.env,
      home,
      originUrl: url,
      facts,
      makeRunner: ({ runId, runDir }) =>
        makeRunner({
          claudePath: machine.claudePath,
          engineEnv: ctx.env,
          home: realHome,
          finReviewHome: home,
          runDir,
          runId,
          systemPrompt: procedure.systemPrompt,
          models: config.models,
          clock,
          clientVersion,
          extraDenied: denied,
        }),
      maxSessions: machine.maxSessions,
      engineRoot,
      engineCopy: services?.engineCopy ?? ((input: EngineCopyInput) => checkEngineCopy(engineRoot, input)),
      clock,
      random,
      stdout: ctx.stdout,
      stderr: ctx.stderr,
    },
  );
}
