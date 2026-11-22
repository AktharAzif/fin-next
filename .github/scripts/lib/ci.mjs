// Shared helpers for the CI scripts in .github/scripts (a control path, DECISIONS CI-14). Node
// built-ins only, so a job can run any of these scripts before (or without) an install, and the
// engine copy of main that `plan` and `gate` check out (spec 07 §11.2) carries everything it needs.
//
// Every line printed from data a script read (a path, a commit header, a job result) goes through
// `clean` first, so it can carry neither a new line that a runner would read as a workflow command
// nor a terminal control sequence.
//
// The scripts fail closed on a Node they were not written for. Each runs its command line only
// when `isMain(import.meta)` holds; a Node without `import.meta.main` (before 22.18 and 24.2)
// would otherwise skip that block and exit 0 having checked nothing. So importing this file on
// such a Node, or on one older than NODE_FLOOR (the repository's engines floor), throws, and every
// script that imports it exits non-zero before it runs.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

/** The oldest Node major the scripts run on: package.json's engines floor. */
export const NODE_FLOOR = 26;

/**
 * Why a runtime cannot run the CI scripts, or null when it can.
 * @param {{ main?: unknown }} meta a module's import.meta
 * @param {string} version process.versions.node
 * @returns {string | null}
 */
export function runtimeProblem(meta, version) {
  const major = Number(/^(\d+)\./.exec(version)?.[1] ?? Number.NaN);
  if (Number.isNaN(major) || major < NODE_FLOOR) {
    return `the CI scripts need Node ${NODE_FLOOR} or newer; this is Node ${version}`;
  }
  if (typeof meta.main !== "boolean") {
    return `this Node (${version}) has no import.meta.main, so a script could not tell it was run`;
  }
  return null;
}

/**
 * Whether the module whose import.meta this is was run as the program. Throws when the runtime
 * cannot say, so a script never mistakes "unknown" for "imported" and exits 0 unchecked.
 * @param {{ main?: unknown }} meta
 * @returns {boolean}
 */
export function isMain(meta) {
  if (typeof meta.main !== "boolean") {
    throw new Error(runtimeProblem(meta, process.versions.node) ?? "import.meta.main is missing");
  }
  return meta.main;
}

const RUNTIME_PROBLEM = runtimeProblem(import.meta, process.versions.node);
if (RUNTIME_PROBLEM !== null) throw new Error(RUNTIME_PROBLEM);

export const ZERO_SHA = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/;

/**
 * A full, lower-case 40-character commit SHA.
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSha(value) {
  return typeof value === "string" && SHA.test(value);
}

/**
 * A printable, single-line form of a value read from data: control characters (new lines
 * included) become `?`, and the text is cut at `max` characters.
 * @param {unknown} value
 * @param {number} [max]
 * @returns {string}
 */
export function clean(value, max = 300) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to replace them
  const text = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "?");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Escapes a message for a workflow command (`::notice::<message>`), as the runner reads it.
 * @param {string} message
 * @returns {string}
 */
export function commandMessage(message) {
  return message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/**
 * Writes one line to standard output.
 * @param {string} line
 */
export function say(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Writes one line to standard error.
 * @param {string} line
 */
export function warn(line) {
  process.stderr.write(`${line}\n`);
}

/**
 * A workflow annotation line (notice, warning or error) with a title.
 * @param {"notice" | "warning" | "error"} level
 * @param {string} title
 * @param {string} message
 * @returns {string}
 */
export function annotation(level, title, message) {
  const safeTitle = commandMessage(clean(title, 80)).replaceAll(":", "%3A").replaceAll(",", "%2C");
  return `::${level} title=${safeTitle}::${commandMessage(clean(message, 2000))}`;
}

/**
 * Prints a workflow annotation (notice, warning or error) with a title.
 * @param {"notice" | "warning" | "error"} level
 * @param {string} title
 * @param {string} message
 */
export function annotate(level, title, message) {
  say(annotation(level, title, message));
}

/**
 * Appends `name=value` to the step's output file. A value is one line; anything else is refused,
 * so no value can start another output.
 * @param {string} name
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function setOutput(name, value, env = process.env) {
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) throw new Error(`bad output name ${clean(name)}`);
  if (/[\r\n]/.test(value)) throw new Error(`the output ${name} must be one line`);
  const file = env.GITHUB_OUTPUT;
  if (file === undefined || file === "") {
    say(`${name}=${value}`);
    return;
  }
  appendFileSync(file, `${name}=${value}\n`);
}

/**
 * Appends Markdown to the job summary, when the runner gives one.
 * @param {string} markdown
 * @param {NodeJS.ProcessEnv} [env]
 */
export function addSummary(markdown, env = process.env) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (file !== undefined && file !== "") appendFileSync(file, `${markdown}\n`);
}

/**
 * The environment git runs with: the caller's, less any GIT_* variable that could point it at
 * another repository, index or object store.
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function gitEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key.toUpperCase().startsWith("GIT_")) out[key] = value;
  }
  out.GIT_TERMINAL_PROMPT = "0";
  return out;
}

/**
 * Runs git with literal arguments (never through a shell) and returns its standard output.
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, maxBuffer?: number }} [options]
 * @returns {string}
 */
export function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: options.cwd ?? process.cwd(),
    env: gitEnv(options.env ?? process.env),
    encoding: "utf8",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * A plain object (not null, not an array).
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON with object keys sorted at every depth, so two documents with the same content compare
 * equal whatever order their keys were written in.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}
