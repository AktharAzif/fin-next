// Command dispatch, argument parsing and exit codes (spec 07 §2.1, §2.2, §3.2, §3.5).
//
// Order of work for every command: load and validate the committed configuration (exit 78 on
// any problem); for a command that resolves review options (every command but plan, help and
// doctor), refuse an environment that holds a variable config/env-refusals.json names (exit 78,
// `environment_refused`, §3.5 and §4.3); parse the arguments, refuse (exit 64, one
// `fin-review: refused: <code>: <message>` line per error) before anything else happens, then run.
// The doctor reports a refused environment as its check D4, starts no session and exits 78.
// Every line printed from data the engine read (a path, a package name, a program's message) is
// escaped first, so it can carry neither a terminal control sequence nor a new line that a CI log
// would read as a workflow command.

import { appendFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { loadEngineConfig } from "./config.ts";
import type { EngineConfig } from "./config.ts";
import { escapeText } from "./display.ts";
import { checkEnvironment } from "./env-refusals.ts";
import { ConfigError, DataError, EXIT, ProgramError } from "./errors.ts";
import { ZERO_SHA, isSha } from "./git.ts";
import { finReviewHome } from "./home.ts";
import { readJsonFile } from "./json.ts";
import { MAX_CONFIG_BYTES, OPTION_FLAGS, displayValue, modelIdOf, parseMachineOptions, parseReviewOptions } from "./options.ts";
import type { OptionError, OptionKey, ReviewOptions } from "./options.ts";
import { COMPUTED_EVENTS, EVENT_RE, computePlan, planOutputLine } from "./plan/plan.ts";
import { ROLES, floorViolations, isTier, sessionModel } from "./roles.ts";
import type { FloorViolation, Role, SessionModel, Tier } from "./roles.ts";
import { runDoctor } from "./doctor.ts";
import type { DoctorServices } from "./doctor.ts";
import { runReviewCommand } from "./review/commands.ts";
import type { ReviewServices } from "./review/commands.ts";

export interface CliContext {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  /** tools/fin-review/config of the engine that runs. */
  readonly configDir: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** The clock, randomness, sessions and GitHub reads of `pr`, `commit` and `doctor`; tests replace them. */
  readonly services?: ReviewServices & DoctorServices;
}

/** Codes for refused run options; the R11 options use OptionErrorCode. */
export type RunErrorCode = "unknown_command" | "unknown_option" | "duplicate_option" | "wrong_type" | "missing_option" | "invalid_value";

export interface Refusal {
  readonly code: string;
  readonly message: string;
}

export interface FlagSpec {
  readonly flag: string;
  readonly key: string;
  readonly takesValue: boolean;
  /** True for the five R11 options, which go through parseReviewOptions. */
  readonly review: boolean;
}

export const REVIEW_FLAGS: readonly FlagSpec[] = (Object.keys(OPTION_FLAGS) as OptionKey[]).map((key) => ({
  flag: OPTION_FLAGS[key],
  key,
  takesValue: key !== "fast",
  review: true,
}));

const PLAN_FLAGS: readonly FlagSpec[] = [
  { flag: "--base", key: "base", takesValue: true, review: false },
  { flag: "--head", key: "head", takesValue: true, review: false },
  { flag: "--tree", key: "tree", takesValue: true, review: false },
  { flag: "--ci", key: "ci", takesValue: false, review: false },
  { flag: "--output", key: "output", takesValue: true, review: false },
];

const OPTIONS_FLAGS: readonly FlagSpec[] = [
  ...REVIEW_FLAGS,
  { flag: "--tier", key: "tier", takesValue: true, review: false },
  { flag: "--advisory", key: "advisory", takesValue: false, review: false },
];

interface ParsedArgs {
  /** The R11 options as given, for parseReviewOptions (null means a flag with no value). */
  readonly review: Record<string, unknown>;
  readonly reviewDuplicates: string[];
  /** Run options: a string value, or true for a flag. */
  readonly run: Map<string, string | true>;
  readonly refusals: Refusal[];
}

export function refusal(code: RunErrorCode, message: string): Refusal {
  return { code, message };
}

/** The longest line printed from data the engine read. */
const MAX_PRINTED_LINE = 4096;

/** One printed line: escaped, so nothing it holds can start a new line or a control sequence. */
export function line(text: string): string {
  return `${escapeText(text, MAX_PRINTED_LINE)}\n`;
}

/**
 * Commands the dispatch does not refuse for their environment: plan and help resolve no review
 * options, and the doctor reports the refusal itself (D4), starting no session, and exits 78.
 */
const ENVIRONMENT_UNCHECKED: ReadonlySet<string> = new Set(["plan", "help", "--help", "-h", "doctor"]);

export function shown(value: string): string {
  return `"${displayValue(value)}"`;
}

/** Parses `--x v` and `--x=v` forms against `specs`. Exported for tests. */
export function parseArgs(tokens: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const byFlag = new Map(specs.map((spec) => [spec.flag, spec]));
  const review = Object.create(null) as Record<string, unknown>;
  const reviewDuplicates: string[] = [];
  const run = new Map<string, string | true>();
  const refusals: Refusal[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    if (!token.startsWith("--") || token === "--") {
      refusals.push(refusal("unknown_option", `Unexpected argument ${shown(token)}.`));
      continue;
    }
    const eq = token.indexOf("=");
    const flag = eq < 0 ? token : token.slice(0, eq);
    const inline = eq < 0 ? undefined : token.slice(eq + 1);
    const spec = byFlag.get(flag);
    if (spec === undefined) {
      refusals.push(refusal("unknown_option", `Unknown option ${shown(flag)}.`));
      continue;
    }
    let value: string | true | null;
    if (!spec.takesValue) value = inline ?? true;
    else if (inline !== undefined) value = inline;
    else {
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      } else value = null;
    }
    if (seen.has(spec.key)) {
      if (spec.review) {
        if (!reviewDuplicates.includes(spec.key)) reviewDuplicates.push(spec.key);
      } else refusals.push(refusal("duplicate_option", `${spec.flag} was given more than once.`));
      continue;
    }
    seen.add(spec.key);
    if (spec.review) {
      review[spec.key] = value;
      continue;
    }
    if (value === null) refusals.push(refusal("wrong_type", `${spec.flag} needs a value.`));
    else if (!spec.takesValue && value !== true) refusals.push(refusal("wrong_type", `${spec.flag} is a flag and takes no value.`));
    else run.set(spec.key, value);
  }
  for (const key of reviewDuplicates) delete review[key];
  return { review, reviewDuplicates, run, refusals };
}

export function printRefusals(ctx: CliContext, refusals: readonly Refusal[]): number {
  for (const item of refusals) ctx.stderr(`fin-review: refused: ${item.code}: ${item.message}\n`);
  return EXIT.usage;
}

export function optionRefusals(errors: readonly OptionError[]): Refusal[] {
  return errors.map((error) => ({ code: error.code, message: error.message }));
}

const HELP = `fin-review: the review engine (spec 07)

Usage: node tools/fin-review/src/main.ts <command> [options]

Commands:
  plan       The CI plan: changed files, tiers, path classes, job flags, affected packages
  options    Print the resolved review options and each role's model and effort, as JSON
  pr         Review a pull request in locked local sessions (the gate)
  commit     Review a pull request's delta since its last reviewed head; escalates to pr
  doctor     Check the session lock-down (D1, D2, D4; D5 with --live)
  help       Print this text

pr --pr <n> [--repo <dir>] [R11 options] [--advisory]:
commit --pr <n> --since <sha> [--repo <dir>] [R11 options] [--advisory]:
  --pr <n>                    The pull request; its head is fetched into $FIN_REVIEW_HOME
  --since <sha>               commit: the last reviewed head (a local run of pr or commit at it)
  --repo <dir>                The repository whose origin holds the pull request (default: .)
  --advisory                  Run below the tier S effort floor; not a gate result
  Prints counts only; findings go to $FIN_REVIEW_HOME/runs/<run-id>/ (default ~/.fin-review).
  Exit 0 no blockers, 1 blockers, 2 could not check, 64 refused, 69 unavailable, 75 busy, 78 lock-down.

doctor [--live]:
  --live                      Also start one locked session per model (D5; costs a little)

plan:
  --base <sha> --head <sha>   The merge-base diff base...head (40-character SHAs)
  --tree <dir>                The repository to read (default: the current directory)
  --ci                        Read EVENT_NAME, BASE_SHA and HEAD_SHA from the environment
  --output <file>             With --ci, append plan=<one-line JSON> to <file> ($GITHUB_OUTPUT)

options (R11: only opus or fable, each effort high or above):
  --model opus|fable               Overall model (default from config/defaults.json)
  --effort high|xhigh|max          Overall effort
  --attack-model opus|fable        Attack pass and second sceptic model
  --attack-effort high|xhigh|max   Attack pass and second sceptic effort
  --fast                           Fast mode (Opus sessions only)
  --tier S|N|D                     Also check [RV-06]'s effort floor for a gating run on that tier
  --advisory                       With --tier, report a floor breach instead of refusing

Fable overall with an Opus attack is refused; Opus overall with a Fable attack is allowed.
Every option takes "--name value" or "--name=value". Exit codes: 0 pass, 1 blocked, 2 could not
check, 64 refused, 65 bad data, 69 unavailable, 70 internal error, 75 busy, 78 configuration.
`;

const DOCTOR_FLAGS: readonly FlagSpec[] = [{ flag: "--live", key: "live", takesValue: false, review: false }];

function doctorCommand(ctx: CliContext, config: EngineConfig, tokens: readonly string[]): Promise<number> | number {
  const args = parseArgs(tokens, DOCTOR_FLAGS);
  if (args.refusals.length > 0) return printRefusals(ctx, args.refusals);
  return runDoctor(ctx, config, args.run.get("live") === true, ctx.services);
}

/** Runs one command and returns its exit code. Never throws. */
export async function runCli(ctx: CliContext): Promise<number> {
  try {
    return await dispatch(ctx);
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const detail of error.details) ctx.stderr(line(`fin-review: config: ${error.file}: ${detail}`));
      return EXIT.config;
    }
    if (error instanceof DataError) {
      ctx.stderr(line(`fin-review: error: ${error.message}`));
      return EXIT.data;
    }
    if (error instanceof ProgramError) {
      ctx.stderr(line(`fin-review: error: ${error.message}`));
      return EXIT.internal;
    }
    ctx.stderr(line(`fin-review: internal error: ${error instanceof Error ? error.message : String(error)}`));
    return EXIT.internal;
  }
}

async function dispatch(ctx: CliContext): Promise<number> {
  const loaded = loadEngineConfig(ctx.configDir);
  if (!loaded.ok) {
    for (const problem of loaded.problems) ctx.stderr(line(`fin-review: config: ${problem.file}: ${problem.message}`));
    return EXIT.config;
  }
  const config = loaded.value;
  const [command, ...rest] = ctx.argv;
  if (command !== undefined && !ENVIRONMENT_UNCHECKED.has(command)) {
    const refused = checkEnvironment(ctx.env, config.envRefusals);
    if (refused.length > 0) {
      for (const variable of refused) {
        ctx.stderr(line(`fin-review: refused: environment_refused: ${variable.name} is set (${variable.kind}); unset it to run fin-review.`));
      }
      return EXIT.config;
    }
  }
  switch (command) {
    case "help":
    case "--help":
    case "-h": {
      if (rest.length > 0) return printRefusals(ctx, [refusal("unknown_option", `help takes no arguments; got ${shown(rest[0] ?? "")}.`)]);
      ctx.stdout(HELP);
      return EXIT.pass;
    }
    case "plan":
      return runPlan(ctx, config, rest);
    case "options":
      return runOptions(ctx, config, rest);
    case "pr":
    case "commit":
      return runReviewCommand(ctx, config, command, rest, ctx.services);
    case "doctor":
      return doctorCommand(ctx, config, rest);
    case undefined:
      ctx.stderr(HELP);
      return printRefusals(ctx, [refusal("unknown_command", "No command given.")]);
    default:
      return printRefusals(ctx, [refusal("unknown_command", `Unknown command ${shown(command)}; run "fin-review help".`)]);
  }
}

// ---- options ----------------------------------------------------------------------------------

/** The machine's local option defaults from $FIN_REVIEW_HOME/config.json (by default ~/.fin-review/config.json). */
export function machineDefaults(ctx: CliContext, config: EngineConfig): ReviewOptions {
  // The same file the review modes read claudePath and maxSessions from: $FIN_REVIEW_HOME, or
  // ~/.fin-review when it is unset, so its options are always applied and always validated.
  const set = ctx.env["FIN_REVIEW_HOME"];
  const userHome = ctx.env["HOME"];
  if ((set === undefined || set === "") && (userHome === undefined || !isAbsolute(userHome))) return config.defaults;
  const home = finReviewHome(ctx.env);
  const file = "$FIN_REVIEW_HOME/config.json";
  const read = readJsonFile(join(home, "config.json"), MAX_CONFIG_BYTES);
  if (!read.ok) {
    if (read.missing) return config.defaults;
    throw new ConfigError(file, [read.error]);
  }
  const parsed = parseMachineOptions(read.value, config.defaults, config.models);
  if (!parsed.ok) throw new ConfigError(file, parsed.errors.map((error) => `${error.code}: ${error.message}`));
  return parsed.value;
}

function runOptions(ctx: CliContext, config: EngineConfig, tokens: readonly string[]): number {
  const args = parseArgs(tokens, OPTIONS_FLAGS);
  const refusals = [...args.refusals];
  const tierValue = args.run.get("tier");
  if (tierValue !== undefined && !isTier(tierValue)) {
    refusals.push(refusal("invalid_value", `--tier must be S, N or D, not ${shown(String(tierValue))}.`));
  }
  const advisory = args.run.get("advisory") === true;
  if (advisory && tierValue === undefined) refusals.push(refusal("missing_option", "--advisory needs --tier."));
  const context = { models: config.models, duplicates: args.reviewDuplicates };
  // First against the committed defaults, so every refusal the arguments alone cause is printed
  // before anything else is read; then over the machine's local defaults.
  const first = parseReviewOptions(args.review, "cli", config.defaults, context);
  if (!first.ok) refusals.push(...optionRefusals(first.errors));
  if (refusals.length > 0) return printRefusals(ctx, refusals);
  const parsed = parseReviewOptions(args.review, "cli", machineDefaults(ctx, config), context);
  if (!parsed.ok) return printRefusals(ctx, optionRefusals(parsed.errors));
  const options = parsed.value;

  let floor: { tier: Tier; advisory: boolean; violations: FloorViolation[] } | undefined;
  if (tierValue !== undefined && isTier(tierValue)) {
    const violations = floorViolations(tierValue, options, config.floor, config.models);
    if (violations.length > 0 && !advisory) {
      return printRefusals(ctx, violations.map((violation) => ({ code: violation.code, message: violation.message })));
    }
    if (advisory) ctx.stderr("advisory: not a gate receipt\n");
    floor = { tier: tierValue, advisory, violations };
  }
  if (options.fast) ctx.stderr("fast: applies to Opus sessions only\n");

  const roles: Partial<Record<Role, SessionModel>> = {};
  for (const role of ROLES) roles[role] = sessionModel(role, options, config.models);
  const out = {
    v: 1,
    options,
    modelIds: { model: modelIdOf(options.model, config.models), attackModel: modelIdOf(options.attackModel, config.models) },
    roles,
    ...(floor === undefined ? {} : { floor }),
  };
  ctx.stdout(`${JSON.stringify(out, null, 2)}\n`);
  return EXIT.pass;
}

// ---- plan -------------------------------------------------------------------------------------

async function runPlan(ctx: CliContext, config: EngineConfig, tokens: readonly string[]): Promise<number> {
  const args = parseArgs(tokens, PLAN_FLAGS);
  const refusals = [...args.refusals];
  const ci = args.run.get("ci") === true;
  const flag = (key: string): string | undefined => {
    const value = args.run.get(key);
    return typeof value === "string" ? value : undefined;
  };

  let event = "local";
  let baseText = flag("base");
  let headText = flag("head");
  if (ci) {
    const eventName = ctx.env["EVENT_NAME"];
    if (eventName === undefined || eventName === "") refusals.push(refusal("missing_option", "--ci needs EVENT_NAME in the environment."));
    else if (!EVENT_RE.test(eventName)) refusals.push(refusal("invalid_value", `EVENT_NAME ${shown(eventName)} is not an event name.`));
    else event = eventName;
    baseText ??= ctx.env["BASE_SHA"];
    headText ??= ctx.env["HEAD_SHA"];
  } else if (flag("output") !== undefined) {
    refusals.push(refusal("invalid_value", "--output is only for --ci."));
  }

  const computed = COMPUTED_EVENTS.includes(event);
  let base: string | null = null;
  if (baseText === undefined || baseText === "" || baseText === ZERO_SHA) {
    if (computed) refusals.push(refusal("missing_option", ci ? `A ${event} plan needs BASE_SHA or --base.` : "plan needs --base <sha>."));
  } else if (!isSha(baseText)) refusals.push(refusal("invalid_value", `The base ${shown(baseText)} is not a 40-character lower-case SHA.`));
  else base = baseText;
  let head: string | null = null;
  if (headText === undefined || headText === "") refusals.push(refusal("missing_option", ci ? "plan --ci needs HEAD_SHA or --head." : "plan needs --head <sha>."));
  else if (!isSha(headText)) refusals.push(refusal("invalid_value", `The head ${shown(headText)} is not a 40-character lower-case SHA.`));
  else head = headText;

  const treeDir = resolve(ctx.cwd, flag("tree") ?? ".");
  const output = flag("output");
  if (refusals.length === 0) {
    let isDir = false;
    try {
      isDir = statSync(treeDir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) refusals.push(refusal("invalid_value", "--tree is not a directory."));
  }
  if (refusals.length > 0 || head === null) return printRefusals(ctx, refusals);

  const result = await computePlan({ treeDir, event, base, head, config, env: ctx.env });
  for (const note of result.notes) ctx.stderr(line(`fin-review: plan: ${note}`));
  for (const problem of result.layoutProblems) ctx.stderr(line(`fin-review: plan: layout: ${problem}`));
  if (result.workspaceProblem !== null) ctx.stderr(line(`fin-review: plan: workspace: ${result.workspaceProblem}`));
  if (ci && output !== undefined) {
    appendFileSync(resolve(ctx.cwd, output), planOutputLine(result.document));
  } else {
    ctx.stdout(`${JSON.stringify(result.document)}\n`);
  }
  return EXIT.pass;
}
