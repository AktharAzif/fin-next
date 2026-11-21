// The CLI runner (spec 07 §4.1): one `claude -p` process per attempt, from the pinned Claude Code at
// an absolute path, with the argument list below, the prompt on stdin, the reviewed tree as the
// working directory, the settings file of §4.2 written fresh, and the environment of §4.3.
//
// Flags are only those the pinned CLI's `--help` documents (the doctor's D2 re-checks them). Two
// planned flags are not in 2.1.328's `--help` and are replaced (docs/review/README.md):
// `--append-system-prompt-file` by `--append-system-prompt` with system.md's text, and
// `--max-turns` by nothing: the session's budget and timeout bound it.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../clock.ts";
import { runProgramSettled } from "../exec.ts";
import type { RunOutcome } from "../exec.ts";
import { EFFORTS } from "../options.ts";
import type { ModelsConfig } from "../options.ts";
import { runWithRetries } from "./check.ts";
import { sessionEnv } from "./env.ts";
import { ALLOWED_TOOLS, DENIED_TOOLS, buildSettings, isWithin, writeSessionFiles } from "./settings.ts";
import type { OutputCheck, SessionResult, SessionRunner, SessionSpec } from "./types.ts";

/** Every flag the runner passes; D2 checks each against the pinned CLI's --help. */
export const RUNNER_FLAGS: readonly string[] = [
  "-p",
  "--model",
  "--effort",
  "--output-format",
  "--json-schema",
  "--settings",
  "--setting-sources",
  "--strict-mcp-config",
  "--mcp-config",
  "--tools",
  "--disallowedTools",
  "--restricted",
  "--permission-prompts",
  "--max-budget-usd",
  "--no-session-persistence",
  "--exclude-dynamic-system-prompt-sections",
  "--append-system-prompt",
];

/** Spec 07 §4.1's flags that 2.1.328's --help does not document, and what replaces each. */
export const REPLACED_FLAGS: Readonly<Record<string, string>> = Object.freeze({
  "--max-turns": "not passed: --max-budget-usd and the session timeout bound the session",
  "--append-system-prompt-file": "--append-system-prompt with the text of docs/review/prompts/system.md",
});

/** Flags no argument list may ever hold (T-RV-08, [RV-19]). */
export const FORBIDDEN_FLAGS: readonly string[] = [
  "--fallback-model",
  "--bare",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--add-dir",
  "--agents",
  "--agent",
  "--plugin-dir",
  "--plugin-url",
  "--betas",
  "--resume",
  "--continue",
];

export const API_HOST = "api.anthropic.com";
const SESSION_ID_RE = /^[a-z0-9][a-z0-9.-]{0,119}$/;
const MODEL_ID_RE = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KILL_GRACE_MS = 10_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_ARG_BYTES = 512 * 1024;

export interface SessionFiles {
  readonly settingsPath: string;
  readonly mcpPath: string;
}

/**
 * The schema as `--json-schema` takes it. Claude Code 2.1.328 refuses a `$schema` naming the 2020-12
 * meta-schema ("no schema with key or ref", found by doctor --live on 21 Nov 2026), so the top-level
 * `$schema` and `$id` annotations are left out; the keywords the engine's schemas use mean the same
 * in every draft, and the engine checks the output against the full schema itself (§2.8 rule 1).
 */
export function cliSchema(schema: object): string {
  const { $schema: _schema, $id: _id, ...rest } = schema as Record<string, unknown>;
  return JSON.stringify(rest);
}

function assertArgPath(path: string, what: string): void {
  if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) throw new TypeError(`${what} must be an absolute path`);
}

/** The argument list of spec 07 §4.1 for one session. Throws TypeError for a value it refuses. */
export function buildArgs(spec: SessionSpec, files: SessionFiles, systemPrompt: string, models: ModelsConfig): string[] {
  if (!MODEL_ID_RE.test(spec.modelId) || (spec.modelId !== models.opus && spec.modelId !== models.fable)) {
    throw new TypeError(`refusing model ${JSON.stringify(spec.modelId)}: only the exact Opus or Fable ID of config/models.json`);
  }
  if (models.retired.includes(spec.modelId)) throw new TypeError(`refusing retired model ${spec.modelId}`);
  if (!EFFORTS.includes(spec.effort)) throw new TypeError(`refusing effort ${JSON.stringify(spec.effort)}`);
  if (typeof spec.maxBudgetUsd !== "number" || !Number.isFinite(spec.maxBudgetUsd) || spec.maxBudgetUsd < 0.01 || spec.maxBudgetUsd > 100) {
    throw new TypeError("maxBudgetUsd must be between 0.01 and 100");
  }
  assertArgPath(files.settingsPath, "the settings file");
  assertArgPath(files.mcpPath, "the MCP config");
  const schema = cliSchema(spec.schema);
  if (Buffer.byteLength(schema, "utf8") > MAX_ARG_BYTES) throw new TypeError("the schema must serialise to at most 512 KB");
  if (systemPrompt === "" || systemPrompt.startsWith("-") || Buffer.byteLength(systemPrompt, "utf8") > MAX_ARG_BYTES) {
    throw new TypeError("the system prompt must be non-empty, at most 512 KB, and not start with -");
  }
  return [
    "-p",
    "--model",
    spec.modelId,
    "--effort",
    spec.effort,
    "--output-format",
    "json",
    "--json-schema",
    schema,
    "--settings",
    files.settingsPath,
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    files.mcpPath,
    "--tools",
    ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    DENIED_TOOLS.join(","),
    "--restricted",
    "--permission-prompts",
    "none",
    "--max-budget-usd",
    spec.maxBudgetUsd.toFixed(2),
    "--no-session-persistence",
    "--exclude-dynamic-system-prompt-sections",
    "--append-system-prompt",
    systemPrompt,
  ];
}

/** Whether a session runs in fast mode: only an Opus session with --fast (S7-13). */
export function effectiveFast(spec: SessionSpec, models: ModelsConfig): boolean {
  return spec.fast && spec.modelId === models.opus;
}

export interface CliRunnerOptions {
  /** The pinned Claude Code, absolute. */
  readonly claudePath: string;
  readonly engineEnv: Readonly<Record<string, string | undefined>>;
  /** The real home directory, resolved. */
  readonly home: string;
  /** $FIN_REVIEW_HOME, resolved. */
  readonly finReviewHome: string;
  /** The run directory (runs/<run-id>), where each session's settings and MCP config are written. */
  readonly runDir: string;
  readonly runId: string;
  /** docs/review/prompts/system.md's text. */
  readonly systemPrompt: string;
  readonly models: ModelsConfig;
  readonly clock: Clock;
  /** The version D1 read (`claude --version`). */
  readonly clientVersion: string;
  /** Other directories to deny ($FIN_REVIEW_SPOOL, $FIN_REVIEW_SHARE). */
  readonly extraDenied: readonly string[];
}

function checkSpec(spec: SessionSpec, o: CliRunnerOptions): void {
  if (!SESSION_ID_RE.test(spec.id)) throw new TypeError(`refusing session ID ${JSON.stringify(spec.id)}`);
  if (!isWithin(o.finReviewHome, spec.treeDir) || spec.treeDir === o.finReviewHome) throw new TypeError("a session's tree must lie inside FIN_REVIEW_HOME");
  if (Buffer.byteLength(spec.prompt, "utf8") > MAX_PROMPT_BYTES) throw new TypeError("the prompt is larger than 4 MB");
}

/**
 * Starts one attempt of a session: writes its settings and MCP config fresh into
 * runs/<run-id>/sessions/<id>/, makes an empty scratch directory for its TMPDIR, runs `claude -p`
 * and removes the scratch directory again.
 */
export async function startAttempt(spec: SessionSpec, attempt: number, o: CliRunnerOptions, signal: AbortSignal): Promise<RunOutcome> {
  checkSpec(spec, o);
  const settings = buildSettings({
    modelId: spec.modelId,
    fastMode: effectiveFast(spec, o.models),
    home: o.home,
    finReviewHome: o.finReviewHome,
    treeDir: spec.treeDir,
    extraDenied: o.extraDenied,
  });
  const files = writeSessionFiles(join(o.runDir, "sessions", spec.id), settings);
  const args = buildArgs(spec, files, o.systemPrompt, o.models);
  const scratch = join(o.finReviewHome, "scratch", `${o.runId}-${spec.id}-a${attempt}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(join(scratch, "tmp"), { recursive: true, mode: 0o700 });
  try {
    return await runProgramSettled(o.claudePath, args, {
      cwd: spec.treeDir,
      env: sessionEnv(o.engineEnv, join(scratch, "tmp")),
      input: Buffer.from(spec.prompt, "utf8"),
      timeoutMs: spec.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      killGraceMs: KILL_GRACE_MS,
      signal,
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Runs sessions as `claude -p` processes. */
export class CliRunner implements SessionRunner {
  private readonly options: CliRunnerOptions;

  constructor(options: CliRunnerOptions) {
    if (!/^\/[A-Za-z0-9._/-]+$/.test(options.claudePath)) throw new TypeError("claudePath must be an absolute path");
    this.options = options;
  }

  async run(spec: SessionSpec, signal: AbortSignal, accept?: OutputCheck): Promise<SessionResult> {
    const o = this.options;
    checkSpec(spec, o);
    return runWithRetries(spec, (n) => startAttempt(spec, n, o, signal), { clock: o.clock, signal, clientVersion: o.clientVersion, apiHost: API_HOST }, accept);
  }
}
