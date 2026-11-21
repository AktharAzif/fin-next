// `doctor` (spec 07 §4.7), the minimal doctor of slice 1 (S7-25): D1 the pinned version (of the file
// claudePath names now); D2 every flag the runner and the doctor pass is in the pinned CLI's --help,
// and the CLI accepts every schema; D3 no settings or configuration file a session could read sets a
// refused key, and the client, started with the locked argument list, the session environment and an
// empty stdin (so no model is called), reports in its debug log that it applied no configuration
// environment; D4 the transport (src/transport.ts) and no refused variable in the engine's
// environment; and with --live D5: one locked session per allowed model answering "ready", through
// the transport, with modelUsage naming only that model ID, at effort high and a 0.50 USD budget.
// Server-managed settings cannot be read locally: D3 records them as unknown. Writes
// $FIN_REVIEW_HOME/state/doctor.json (never inside the engine's repository); exits 0 when every check
// it ran passed, else 78.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CliContext } from "./cli.ts";
import { compactUtc, systemClock, systemRandom } from "./clock.ts";
import type { Clock, RandomSource } from "./clock.ts";
import type { EngineConfig } from "./config.ts";
import { escapeText } from "./display.ts";
import { ConfigError, EXIT } from "./errors.ts";
import { canonicalPath, runProgram } from "./exec.ts";
import { ensureHome, finReviewHome, guardHome, loadMachineConfig } from "./home.ts";
import { LENSES } from "./review/lenses.ts";
import { ATTACK, GENERIC_PROFILE, checklistIds, loadProcedure, sessionSchema } from "./review/procedure.ts";
import type { Procedure } from "./review/procedure.ts";
import { writeJson } from "./review/report.ts";
import { engineTransport } from "./review/commands.ts";
import { doctorSessions } from "./roles.ts";
import { checkAttempt } from "./runner/check.ts";
import { REPLACED_FLAGS, RUNNER_FLAGS, buildArgs, cliSchema, startAttempt } from "./runner/cli.ts";
import type { CliRunnerOptions } from "./runner/cli.ts";
import { compareVersions, parseVersionOutput, pinClient } from "./runner/client.ts";
import type { PinnedClient } from "./runner/client.ts";
import { engineHome, environmentRefusals, SESSION_PATH, sessionEnv } from "./runner/env.ts";
import { buildSettings, writeSessionFiles } from "./runner/settings.ts";
import { checkedSources, settingsRefusals, settingsSources } from "./runner/settings-files.ts";
import type { SourceOverrides } from "./runner/settings-files.ts";
import { DIRECT } from "./transport.ts";
import type { Transport } from "./transport.ts";
import type { RunOutcome } from "./exec.ts";
import type { SessionSpec } from "./runner/types.ts";

export type CheckResult = "pass" | "fail" | "skipped";

export interface DoctorCheck {
  readonly id: "D1" | "D2" | "D3" | "D4" | "D5";
  readonly result: CheckResult;
  readonly detail: string;
  readonly data?: unknown;
}

export interface ClaudeRunOptions {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** What the doctor needs from the machine; tests replace any of it. */
export interface DoctorServices {
  readonly clock: Clock;
  readonly random: RandomSource;
  /**
   * Runs the pinned Claude Code with `args` and an empty stdin; default: the real program, with a
   * minimal environment at / unless `options` gives the environment and folder (D3's probe).
   */
  readonly runClaude?: (claudePath: string, args: readonly string[], options?: ClaudeRunOptions) => Promise<ClaudeRun>;
  /** Starts one D5 session attempt; default: the CLI runner's. */
  readonly startSession?: (spec: SessionSpec, options: CliRunnerOptions) => Promise<RunOutcome>;
  /** The managed-settings folder the pinned Claude Code reads (D3); default: the operating system's. */
  readonly managedSettingsDir?: string;
  /** The other settings sources (D3); default: the machine's. */
  readonly settingsOverrides?: SourceOverrides;
}

export interface ClaudeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export const DOCTOR_PROMPT = "Reply with the word ready.";
/** What 2.1.328 prints when --json-schema is acceptable and no prompt was given (no API call). */
const NO_INPUT_RE = /Input must be provided/;
const BAD_SCHEMA_RE = /not a valid JSON Schema/;
const HELP_TIMEOUT_MS = 30_000;
/** Flags only the doctor passes (D3's probe); D2 checks them too. */
export const DOCTOR_FLAGS_USED: readonly string[] = ["--debug-file"];
/**
 * The line 2.1.328's debug log writes at start: the variables it took from the global
 * configuration's env and from the user settings' env ("none", or an empty list, when it took none).
 */
const CONFIG_ENV_RE = /globalEnv keys: (.*?), settingsEnv keys: (.*)$/m;

function flagPattern(flag: string): RegExp {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s,=<\\[]|$)`, "m");
}

/** The flags of `flags` that `help` does not document. */
export function missingFlags(help: string, flags: readonly string[]): string[] {
  return flags.filter((flag) => !flagPattern(flag).test(help));
}

async function defaultRunClaude(claudePath: string, args: readonly string[], env: Readonly<Record<string, string | undefined>>, options?: ClaudeRunOptions): Promise<ClaudeRun> {
  const result = await runProgram(claudePath, args, {
    cwd: options?.cwd ?? "/",
    env: options?.env ?? { PATH: SESSION_PATH, HOME: engineHome(env), LANG: "C.UTF-8", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
    timeoutMs: HELP_TIMEOUT_MS,
    maxOutputBytes: 4 * 1024 * 1024,
  });
  return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr.toString("utf8") };
}

/** Every schema the engine passes to --json-schema, by name. */
function engineSchemas(procedure: Procedure): Array<{ name: string; schema: object }> {
  const out: Array<{ name: string; schema: object }> = [];
  for (const lens of LENSES) out.push({ name: `lens-${lens}`, schema: sessionSchema(procedure, lens, null, checklistIds(procedure, lens), []) });
  out.push({ name: "lens-security-with-prior-blockers", schema: sessionSchema(procedure, "security", null, checklistIds(procedure, "security"), ["P1"]) });
  out.push({ name: "attack", schema: sessionSchema(procedure, ATTACK, GENERIC_PROFILE, checklistIds(procedure, ATTACK), []) });
  out.push({ name: "sceptic", schema: procedure.schemas.sceptic }, { name: "second-look", schema: procedure.schemas.secondLook }, { name: "doctor", schema: procedure.schemas.doctor });
  return out;
}

function isReady(output: unknown): boolean {
  if (typeof output !== "object" || output === null) return false;
  const answer = (output as Record<string, unknown>)["answer"];
  return typeof answer === "string" && /^ready\.?$/i.test(answer.trim());
}

/** The env keys a debug log says the client applied from its configuration, or null when it does not say. */
export function configEnvKeys(log: string): { globalEnv: string[]; settingsEnv: string[] } | null {
  const match = CONFIG_ENV_RE.exec(log);
  if (match === null) return null;
  const keys = (text: string): string[] => (text.trim() === "none" ? [] : text.split(",").map((key) => key.trim()).filter((key) => key !== ""));
  return { globalEnv: keys(match[1] ?? ""), settingsEnv: keys(match[2] ?? "") };
}

interface ProbeInput {
  readonly ctx: CliContext;
  readonly config: EngineConfig;
  readonly procedure: Procedure;
  readonly home: string;
  readonly realHome: string;
  readonly claudePath: string;
  readonly transport: Transport;
  readonly denied: readonly string[];
  readonly runId: string;
  readonly runClaude: (claudePath: string, args: readonly string[], options?: ClaudeRunOptions) => Promise<ClaudeRun>;
}

/**
 * D3's probe: the pinned client started as a session is (the locked argument list, the session
 * environment of the transport, the tree as its folder) with an empty stdin and --debug-file, so it
 * stops before any model call; its log must say it applied no env from its configuration.
 */
async function configProbe(input: ProbeInput): Promise<{ ok: boolean; detail: string }> {
  const { home, runId, config } = input;
  const treeDir = join(home, "trees", runId);
  const sessionDir = join(home, "state", "doctor-sessions", runId);
  const scratch = join(home, "scratch", runId);
  const debugFile = join(scratch, "debug.log");
  mkdirSync(treeDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(scratch, "tmp"), { recursive: true, mode: 0o700 });
  try {
    const [model] = doctorSessions(config.models);
    if (model === undefined) return { ok: false, detail: "no model to probe with" };
    const spec: SessionSpec = {
      id: "doctor-probe",
      role: "doctor",
      modelId: model.modelId,
      effort: model.effort,
      fast: false,
      treeDir,
      prompt: "",
      schema: input.procedure.schemas.doctor,
      maxTurns: config.budgets.maxTurns.doctor,
      maxBudgetUsd: config.budgets.sessionUsd.doctor,
      timeoutMs: HELP_TIMEOUT_MS,
    };
    const settings = buildSettings({ modelId: spec.modelId, fastMode: false, home: input.realHome, finReviewHome: home, treeDir, extraDenied: input.denied });
    const files = writeSessionFiles(sessionDir, settings);
    const args = [...buildArgs(spec, files, input.procedure.systemPrompt, config.models), "--debug-file", debugFile];
    const env = sessionEnv(input.ctx.env, join(scratch, "tmp"), input.transport);
    const run = await input.runClaude(input.claudePath, args, { env, cwd: treeDir });
    if (!NO_INPUT_RE.test(`${run.stdout}\n${run.stderr}`)) return { ok: false, detail: "the probe did not stop for want of input as the locked client should" };
    let log: string;
    try {
      log = readFileSync(debugFile, "utf8");
    } catch {
      return { ok: false, detail: "the probe wrote no debug log" };
    }
    const keys = configEnvKeys(log);
    if (keys === null) return { ok: false, detail: "the probe's debug log does not say which configuration env the client applied" };
    if (keys.globalEnv.length > 0 || keys.settingsEnv.length > 0) {
      const names = [...keys.globalEnv.map((key) => `global ${key}`), ...keys.settingsEnv.map((key) => `settings ${key}`)].map((name) => escapeText(name, 80));
      return { ok: false, detail: `the client applied env from its configuration: ${names.join(", ")}` };
    }
    return { ok: true, detail: "the locked client applied no env from its configuration" };
  } catch (error) {
    return { ok: false, detail: `the probe could not run (${escapeText(error instanceof Error ? error.message : String(error), 200)})` };
  } finally {
    rmSync(treeDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs `doctor [--live]`. */
export async function runDoctor(ctx: CliContext, config: EngineConfig, live: boolean, services?: DoctorServices): Promise<number> {
  const clock = services?.clock ?? systemClock;
  const random = services?.random ?? systemRandom;
  const engineRoot = canonicalPath(resolve(ctx.configDir, "..", "..", ".."));
  const homePath = finReviewHome(ctx.env);
  guardHome(homePath, [engineRoot]);
  const home = ensureHome(homePath);
  const machine = loadMachineConfig(home, ctx.env);
  const runClaude =
    services?.runClaude ?? ((path: string, args: readonly string[], options?: ClaudeRunOptions) => defaultRunClaude(path, args, ctx.env, options));
  const checks: DoctorCheck[] = [];
  const procedure = loadProcedure(join(engineRoot, "docs", "review"));
  const stamp = `${compactUtc(clock.now()).toLowerCase()}-${random(4).toString("hex")}`;

  // The transport, which decides the session environment and the settings sources (D3, D4, D5).
  let transport: Transport = DIRECT;
  let transportDenied: string[] = [];
  let transportProblem: string | null = null;
  try {
    const resolved = engineTransport(ctx.env, home);
    transport = resolved.transport;
    transportDenied = resolved.denied;
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    transportProblem = error.details.map((detail) => `${error.file}: ${detail}`).join("; ");
  }

  // The settings and configuration files first (D3's first half), so a client whose configuration
  // would change its environment is not started by D2's schema probes either.
  const realHome = canonicalPath(engineHome(ctx.env));
  const sources = settingsSources(realHome, transport, {
    ...(services?.managedSettingsDir === undefined ? {} : { managedSettingsDir: services.managedSettingsDir }),
    ...(services?.settingsOverrides ?? {}),
  });
  const refusedSettings = await settingsRefusals(sources, config.envRefusals);

  // D1: the version of the file claudePath names now equals the pin and is at least the minimum.
  let pinned: PinnedClient | null = null;
  let pinProblem = "";
  try {
    pinned = pinClient(machine.claudePath);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    pinProblem = error.details.join("; ");
  }
  const claudePath = pinned?.path ?? machine.claudePath;
  let clientVersion: string | null = null;
  try {
    if (pinned !== null) {
      const out = await runClaude(claudePath, ["--version"]);
      clientVersion = out.code === 0 ? parseVersionOutput(out.stdout) : null;
    }
  } catch {
    clientVersion = null;
  }
  const pin = config.client;
  if (pinned === null) checks.push({ id: "D1", result: "fail", detail: pinProblem });
  else if (clientVersion === null) checks.push({ id: "D1", result: "fail", detail: "claude --version could not be read from claudePath" });
  else if (clientVersion !== pin.claudeCode || compareVersions(clientVersion, pin.minimum) < 0) {
    checks.push({ id: "D1", result: "fail", detail: `claude is ${clientVersion}; the pin is ${pin.claudeCode} (minimum ${pin.minimum})` });
  } else checks.push({ id: "D1", result: "pass", detail: `claude ${clientVersion} equals the pin (minimum ${pin.minimum})` });

  // D2: every flag the runner and the doctor pass is documented by --help, and the CLI accepts every
  // schema the engine passes to --json-schema (it checks the schema before it reads a prompt, so no
  // model is called: an empty stdin ends the run at "Input must be provided").
  try {
    if (pinned === null) throw new Error("claudePath names no file");
    const out = await runClaude(claudePath, ["--help"]);
    if (out.code !== 0) checks.push({ id: "D2", result: "fail", detail: "claude --help failed" });
    else {
      const missing = missingFlags(out.stdout, [...RUNNER_FLAGS, ...DOCTOR_FLAGS_USED]);
      const replaced = Object.keys(REPLACED_FLAGS);
      const nowDocumented = replaced.filter((flag) => missingFlags(out.stdout, [flag]).length === 0);
      const schemas = engineSchemas(procedure);
      const refusedSchemas: string[] = [];
      const probing = missing.length === 0 && refusedSettings.length === 0;
      if (probing) {
        for (const { name, schema } of schemas) {
          const probe = await runClaude(claudePath, ["-p", "--output-format", "json", "--json-schema", cliSchema(schema)]);
          const text = `${probe.stdout}\n${probe.stderr}`;
          if (BAD_SCHEMA_RE.test(text) || !NO_INPUT_RE.test(text)) refusedSchemas.push(name);
        }
      }
      const data = { checked: RUNNER_FLAGS, doctorFlags: DOCTOR_FLAGS_USED, missing, replaced: REPLACED_FLAGS, replacedNowDocumented: nowDocumented, refusedSchemas };
      const now = nowDocumented.length > 0 ? ` (now documented: ${nowDocumented.join(", ")})` : "";
      if (missing.length > 0) checks.push({ id: "D2", result: "fail", detail: `--help does not document ${missing.join(", ")}`, data });
      else if (!probing) checks.push({ id: "D2", result: "fail", detail: "--json-schema not probed: a settings or configuration file a session could read is refused (D3)", data });
      else if (refusedSchemas.length > 0) checks.push({ id: "D2", result: "fail", detail: `--json-schema refuses ${refusedSchemas.join(", ")}`, data });
      else {
        checks.push({
          id: "D2",
          result: "pass",
          detail: `all ${RUNNER_FLAGS.length} runner flags are in --help; replaced: ${replaced.join(", ")}${now}; --json-schema accepts all ${schemas.length} schemas`,
          data,
        });
      }
    }
  } catch {
    checks.push({ id: "D2", result: "fail", detail: "claude --help could not be run" });
  }

  // D3: no settings or configuration file a session could read sets a refused key (file paths and
  // key names only), and the locked client applies no env from its configuration.
  const serverManaged = "server-managed settings: unknown (not readable locally)";
  const checked = checkedSources(sources);
  if (refusedSettings.length > 0) {
    checks.push({ id: "D3", result: "fail", detail: refusedSettings.map((item) => `${escapeText(item.file)}: ${item.problem}`).join("; "), data: { refused: refusedSettings, checked } });
  } else if (pinned === null || transportProblem !== null) {
    checks.push({ id: "D3", result: "fail", detail: "no settings file sets a refused key, but the configuration probe could not run (D1 or D4 failed)", data: { checked } });
  } else {
    const probe = await configProbe({ ctx, config, procedure, home, realHome, claudePath, transport, denied: transportDenied, runId: `doctor-probe-${stamp}`, runClaude });
    checks.push({
      id: "D3",
      result: probe.ok ? "pass" : "fail",
      detail: probe.ok ? `no settings or configuration file a session could read sets a refused key; ${probe.detail}; ${serverManaged}` : probe.detail,
      data: { checked, serverManaged: "unknown" },
    });
  }

  // D4: the transport, and no refused variable in the engine's environment (names only, never values).
  if (transportProblem !== null) checks.push({ id: "D4", result: "fail", detail: `the transport cannot be used: ${transportProblem}` });
  else {
    const found = environmentRefusals(ctx.env, config.envRefusals, transport);
    const via = transport.kind === "pool" ? `transport pool (forwarder ${transport.host})` : "transport direct";
    checks.push(
      found.length === 0
        ? { id: "D4", result: "pass", detail: `${via}; none of the ${config.envRefusals.variables.length} refused variables is set`, data: { transport: transport.kind } }
        : { id: "D4", result: "fail", detail: `${via}; refused variables set: ${found.map((item) => `${item.name} (${item.kind})`).join(", ")}`, data: { transport: transport.kind, refused: found } },
    );
  }

  // D5: each allowed model answers in a locked session, through the transport, and only that model is used.
  if (!live) checks.push({ id: "D5", result: "skipped", detail: "run doctor --live to start one locked session per model" });
  else if (pinned === null || checks.some((check) => check.result !== "pass")) checks.push({ id: "D5", result: "skipped", detail: "not started: D1, D2, D3 or D4 failed" });
  else {
    const runId = `doctor-${stamp}`;
    const runDir = join(home, "state", "doctor-sessions", runId);
    const treeDir = join(home, "trees", runId);
    mkdirSync(treeDir, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const options: CliRunnerOptions = {
      claudePath: pinned.path,
      claudeFingerprint: pinned.fingerprint,
      engineEnv: ctx.env,
      home: realHome,
      finReviewHome: home,
      runDir,
      runId,
      systemPrompt: procedure.systemPrompt,
      models: config.models,
      clock,
      clientVersion: clientVersion ?? "",
      extraDenied: transportDenied,
      transport,
    };
    const start = services?.startSession ?? ((spec: SessionSpec, o: CliRunnerOptions) => startAttempt(spec, 1, o, new AbortController().signal));
    const results: unknown[] = [];
    let allPass = true;
    try {
      for (const model of doctorSessions(config.models)) {
        const spec: SessionSpec = {
          id: `doctor-${model.model}`,
          role: "doctor",
          modelId: model.modelId,
          effort: model.effort,
          fast: false,
          treeDir,
          prompt: DOCTOR_PROMPT,
          schema: procedure.schemas.doctor,
          maxTurns: config.budgets.maxTurns.doctor,
          maxBudgetUsd: config.budgets.sessionUsd.doctor,
          timeoutMs: config.budgets.timeoutMinutes.doctor * 60_000,
        };
        const started = clock.now();
        const outcome = await start(spec, options);
        const check = checkAttempt(spec, outcome, (output) => (isReady(output) ? null : 'the answer is not "ready"'));
        const pass = check.ok && check.modelObserved.length === 1 && check.modelObserved[0] === model.modelId;
        if (!pass) allPass = false;
        results.push({
          model: model.model,
          modelId: model.modelId,
          effort: model.effort,
          transport: transport.kind,
          pass,
          failure: check.failure ?? null,
          detail: check.detail,
          modelObserved: check.modelObserved,
          costMicroUsd: check.costMicroUsd,
          durationMs: Math.max(0, clock.now() - started),
          resultFields: check.resultFields,
        });
      }
    } finally {
      rmSync(treeDir, { recursive: true, force: true });
    }
    const line = results
      .map((item) => {
        const r = item as { modelId: string; pass: boolean; failure: string | null; detail: string };
        return `${r.modelId} ${r.pass ? "answered ready, modelUsage names only it" : `failed (${r.failure ?? "answer"}: ${r.detail})`}`;
      })
      .join("; ");
    checks.push({ id: "D5", result: allPass ? "pass" : "fail", detail: `${line} (transport ${transport.kind})`, data: results });
  }

  const ran = checks.filter((check) => check.result !== "skipped");
  const passed = checks.every((check) => check.result === "pass");
  const doc = { v: 1, at: new Date(clock.now()).toISOString(), clientVersion, transport: transport.kind, live, passed, checks };
  mkdirSync(join(home, "state"), { recursive: true, mode: 0o700 });
  writeJson(join(home, "state", "doctor.json"), doc);
  for (const check of checks) ctx.stdout(`${check.id} ${check.result}: ${check.detail}\n`);
  ctx.stdout(`doctor: ${passed ? "passed" : ran.every((check) => check.result === "pass") ? "the checks run passed; D5 needs --live" : "failed"}\n`);
  return ran.every((check) => check.result === "pass") ? EXIT.pass : EXIT.config;
}
