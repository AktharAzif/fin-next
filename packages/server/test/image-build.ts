// The release images' server builds, read from the Dockerfiles that make them and the scripts those
// run, for the harness guard's real-bundle tests (src/build/harness-guard.test.ts) and the release
// image's pins (src/build/release-image.test.ts). The real-bundle tests build what this returns, so
// they build what each image's build runs, not a config file they assume:
//   - each ops/docker/*.Dockerfile's `release` stage (the target the release workflow builds) and
//     the one stage of the Dockerfile's own, built from the repository, whose output it copies
//     (beside it, the release stage may take only the copies ops/docker/release-allowlist.json
//     names for that Dockerfile, word for word, each from a stage that is nothing but RUNs whose
//     steps are exactly the command the entry names as making the copy, word for word, and then
//     the output scan over exactly what it copies, with no ARG, ENV, WORKDIR or SHELL of its own,
//     built on the stage the bundle's build stage is built on and run where that stage runs pnpm;
//     any other copy from a stage that holds the repository is a second bundle copy),
//     with the file's lines, each instruction's flags and each COPY's --from read as Docker reads
//     them (a stage by index or by name in any case and quoting, an image only by digest), and a
//     parent stage that runs a command or copies from the repository refused, as ONBUILD is; a
//     Dockerfile that holds any character but printable ASCII, tabs and newlines, or that names
//     two stages alike (Docker reads the last), is refused rather than read;
//     that stage's one RUN, read as a list of steps joined by `&&` (so any step's failure fails
//     the RUN): `test` checks, exactly one `[NAME=value ...] pnpm --filter <package> run
//     <script>`, and right after it the output scan, `node ops/docker/harness-scan.mjs <dir>`,
//     over exactly the directory the release stage copies;
//   - the environment that step runs in: the ENV of the stage and of the stages it is built from,
//     the stage's build argument (the app: each app under apps/ is tried as its value, since the
//     release workflow may pass any of them) and the step's own assignments (FIN_BUILD_TARGET);
//   - the workspace package the filter selects (pnpm-workspace.yaml's packages) and its script,
//     which must be exactly `vite build --config <file>`, with no `post` script of its name and no
//     `pre` script but one that is byte for byte a command the allowlist names (pnpm runs both
//     around it; the real-bundle tests replay that pre-script before the build); the config file
//     is that path from the package's directory, where pnpm runs the script.
// The allowlist is data in one file under ops/docker, a control path, each entry with its reason; a
// file that is missing or holds anything but its exact shape refuses every build.
// Anything it cannot read so is refused, by a message naming the Dockerfile, the app and what it
// could not read: a changed script, a second config file or another step fails the tests rather
// than leaving them a build they did not see. A filter that selects no package, or a package with
// no such script, is skipped: pnpm then builds nothing (or fails), the scan finds no output, and
// the image does not build. What this does not reproduce: the base image's own environment
// (NODE_VERSION and the rest), BuildKit's predefined arguments, and the variables pnpm adds for a
// script (npm_lifecycle_event, NODE_PATH and the rest), none of which an app's config reads. A
// config written to behave differently under the test is a review finding by definition (BD-19);
// the image's output scan still fails its build when the harness's markers are in the output.
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";

/** The release image's output scan, which each Dockerfile runs right after the build. */
export const SCAN_SCRIPT = "ops/docker/harness-scan.mjs";

/** The Dockerfiles' directory, relative to the repository's root. */
export const DOCKER_DIRECTORY = "ops/docker";

/** The stage the release workflow builds and ships (`--target release`). */
export const RELEASE_STAGE = "release";

/**
 * What a release image's build may take beside its one server bundle, as data in one place under
 * ops/docker (a control path): the copies its release stage may take and the pre-scripts pnpm may
 * run before its build script, each with its reason.
 */
export const ALLOWLIST_FILE = "ops/docker/release-allowlist.json";

/**
 * A copy a release stage may take beside its bundle: in the Dockerfile `dockerfile` (a repository
 * path) only, a COPY from the stage `stage` (one that holds the repository) of exactly `source` to
 * exactly `destination`, with --from its only flag; that stage runs exactly the command `produces`,
 * word for word, and then the output scan over `source`.
 */
export interface AllowedCopy {
  dockerfile: string;
  stage: string;
  source: string;
  destination: string;
  produces: string;
  reason: string;
}

/**
 * A pre-script pnpm may run before an image's build script: its command, byte for byte, and the
 * file it writes, as a repository path.
 */
export interface AllowedPreScript {
  command: string;
  writes: string;
  reason: string;
}

/** The allowlist file's entries. */
export interface Allowlist {
  copies: AllowedCopy[];
  preScripts: AllowedPreScript[];
}

/** An instruction of a Dockerfile: its keyword in capitals, its text, and the line it starts on. */
export interface Instruction {
  keyword: string;
  text: string;
  line: number;
}

/** One release server build an image runs, read from its Dockerfile and the package's manifest. */
export interface ImageBuild {
  /** The Dockerfile and the build argument it was read with (`...app.Dockerfile, APP=api`). */
  label: string;
  /** The Dockerfile, as a repository path. */
  dockerfile: string;
  /** The package pnpm runs the script in, as a repository path (`apps/api`) and as a directory. */
  package: string;
  directory: string;
  /** The script pnpm runs, and its text. */
  script: string;
  command: string;
  /** The config file the script names, as an absolute path. */
  configFile: string;
  /**
   * The pre-script pnpm runs before the script (`pre<script>`), byte for byte a command the
   * allowlist names, with the file it writes; undefined when the package has none.
   */
  preScript: { command: string; writes: string } | undefined;
  /**
   * The environment the Dockerfile gives the build step: its stages' ENV, the build argument and
   * the step's own assignments.
   */
  environment: Record<string, string>;
  /** The directory the build stage scans and the release stage copies, as a repository path. */
  output: string;
  /** The build stage's shell, and its RUN's text as the Dockerfile writes it. */
  shell: string[];
  run: string;
}

/** What the Dockerfiles build: each release build read, each refusal, and each pairing skipped. */
export interface ImageBuilds {
  builds: ImageBuild[];
  refusals: string[];
  skipped: string[];
}

/** A Dockerfile or a script that this module cannot read as the shape it accepts. */
class Unreadable extends Error {}

function fail(message: string): never {
  throw new Unreadable(message);
}

// The blanks Docker's parser trims a line by and splits an instruction's flags at, in ASCII (a
// Dockerfile is read only when it holds nothing but printable ASCII, tabs and newlines, so Docker's
// other blanks never reach the reader).
const BLANK = /[\t\n\v\f\r ]/;
// A parser directive Docker or its frontend may read among the file's first comments.
const DIRECTIVE = /^[\t\n\v\f\r ]*#[\t\n\v\f\r ]*(?:syntax|escape|check)[\t\n\v\f\r ]*=/i;
// A character the reader does not read: anything but printable ASCII, a tab or a newline.
const UNREAD = /[^\t\n\x20-\x7e]/u;

/**
 * The instructions of a Dockerfile, as Docker's parser reads them: comment and blank lines dropped
 * (inside a continued instruction too), and a line that ends in a backslash, then spaces or tabs
 * only, joined to the next one. A Dockerfile that holds any character but printable ASCII, a tab
 * or a newline is refused outright (a carriage return, a form feed, a Unicode blank or mark, which
 * Docker reads otherwise than a plain reading would, in a comment or a parser directive too), and
 * so is what Docker would read otherwise: a parser directive (which can change the escape
 * character or the frontend), a heredoc (whose lines are a file's text, not instructions), however
 * its instruction's lines are continued, and a line that ends in an escaped escape.
 */
export function dockerInstructions(text: string): Instruction[] {
  const instructions: Instruction[] = [];
  let parts: string[] = [];
  let start = 0;
  const end = () => {
    const joined = parts.join("").trim();
    parts = [];
    if (joined.includes("<<")) {
      fail(
        `the instruction on line ${start} holds a heredoc (\`<<\`), which the test does not read`,
      );
    }
    const match = /^([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(joined);
    if (match?.[1] === undefined) fail(`line ${start} is no instruction`);
    instructions.push({ keyword: match[1].toUpperCase(), text: match[2] ?? "", line: start });
  };
  for (const [index, line] of text.split("\n").entries()) {
    const unread = UNREAD.exec(line)?.[0];
    if (unread !== undefined) {
      const code = (unread.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      fail(
        `line ${index + 1} holds U+${code}, a character outside printable ASCII, tab and newline, which the test does not read`,
      );
    }
    if (instructions.length === 0 && parts.length === 0 && DIRECTIVE.test(line)) {
      fail(`line ${index + 1} is a parser directive, which changes how Docker reads the file`);
    }
    if (/^[\t\n\v\f\r ]*(?:#|$)/.test(line)) continue;
    if (/\\\\[ \t]*$/.test(line)) {
      fail(`line ${index + 1} ends in an escaped escape, which the test does not read`);
    }
    if (parts.length === 0) start = index + 1;
    const continued = /\\[ \t]*$/.test(line);
    parts.push(continued ? line.replace(/\\[ \t]*$/, "") : line);
    if (!continued) end();
  }
  if (parts.length > 0) end();
  return instructions;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Characters a shell reads as more than a word's text outside quotes: operators, redirection,
// substitution, globbing, comments, history and escapes.
const SHELL_SPECIAL = /[;|&<>()`{}*?[\]~#!\\]/;

/**
 * Reads `text` as a shell reads a list of simple commands joined by `&&`: words separated by
 * blanks, with double and single quotes, and `$NAME` and `${NAME}` expanded from `env`. Anything
 * else a shell would read (another operator, a substitution, a glob, an escape, a name that is not
 * set) is refused, so the steps are exactly what the shell runs. Returns each step's words.
 */
export function shellSteps(text: string, env: Readonly<Record<string, string>>): string[][] {
  const steps: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let at = 0;
  const value = (name: string): string => {
    const found = env[name];
    if (found === undefined) fail(`\`${text}\` names $${name}, which is not set`);
    return found;
  };
  /** The expansion just past a `$` at `at`, with `at` moved past it. */
  const expansion = (): string => {
    if (text[at] === "{") {
      const end = text.indexOf("}", at);
      const name = end === -1 ? "" : text.slice(at + 1, end);
      if (!NAME.test(name)) fail(`\`${text}\` holds an expansion the test cannot read`);
      at = end + 1;
      return value(name);
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0];
    if (name === undefined) fail(`\`${text}\` holds a \`$\` the test cannot read`);
    at += name.length;
    return value(name);
  };
  const end = () => {
    if (word !== undefined) words.push(word);
    word = undefined;
  };
  while (at < text.length) {
    const char = text[at] ?? "";
    if (/\s/.test(char)) {
      end();
      at++;
    } else if (text.startsWith("&&", at)) {
      end();
      if (words.length === 0) fail(`\`${text}\` holds an empty step`);
      steps.push(words);
      words = [];
      at += 2;
    } else if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close === -1) fail(`\`${text}\` leaves a quote open`);
      word = (word ?? "") + text.slice(at + 1, close);
      at = close + 1;
    } else if (char === '"') {
      let quoted = word ?? "";
      at++;
      for (;;) {
        const inner = text[at];
        if (inner === undefined) fail(`\`${text}\` leaves a quote open`);
        if (inner === '"') break;
        if (inner === "\\" || inner === "`" || (inner === "$" && text[at + 1] === "(")) {
          fail(`\`${text}\` holds an escape or a substitution the test cannot read`);
        }
        if (inner === "$") {
          at++;
          quoted += expansion();
        } else {
          quoted += inner;
          at++;
        }
      }
      word = quoted;
      at++;
    } else if (char === "$") {
      if (text[at + 1] === "(") fail(`\`${text}\` holds a command substitution`);
      at++;
      const expanded = expansion();
      // Unquoted, a shell would split the value at blanks and expand its wildcards.
      if (/[\s*?[\]]/.test(expanded)) fail(`\`${text}\` expands a value a shell would split`);
      word = (word ?? "") + expanded;
    } else if (SHELL_SPECIAL.test(char)) {
      fail(`\`${text}\` holds \`${char}\`, which the test does not read as a word`);
    } else {
      word = (word ?? "") + char;
      at++;
    }
  }
  end();
  if (words.length === 0) fail(`\`${text}\` ends with an empty step`);
  steps.push(words);
  return steps;
}

/** The words of an instruction's text, read as Docker reads them (quotes and expansions). */
function dockerWords(text: string, env: Readonly<Record<string, string>>): string[] {
  const [words, ...more] = shellSteps(text, env);
  if (words === undefined || more.length > 0) fail(`\`${text}\` is not one list of words`);
  return words;
}

/** A stage of a Dockerfile: its name, the stage it is built on, and its instructions. */
interface Stage {
  name: string;
  parent: Stage | undefined;
  instructions: Instruction[];
  /**
   * Whether it holds the repository, or may: it adds or copies from the build context, runs a
   * command (which can mount the repository or fetch it), or copies from or is built on a stage
   * that holds it.
   */
  repository: boolean;
}

/**
 * The flags an instruction's text begins with, as Docker's parser reads them (each word that
 * begins with `--`, its quotes removed and a backslash keeping the character after it, up to the
 * first word that does not begin so or a `--` alone), and the text after them.
 */
export function builderFlags(text: string): { flags: string[]; rest: string } {
  const flags: string[] = [];
  let at = 0;
  for (;;) {
    while (BLANK.test(text[at] ?? "")) at++;
    if (!text.startsWith("--", at)) return { flags, rest: text.slice(at) };
    let word = "";
    let quote: string | undefined;
    let quoted = false;
    for (; at < text.length; at++) {
      let char = text[at] ?? "";
      if (quote === undefined && BLANK.test(char)) break;
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === undefined && (char === "'" || char === '"')) {
        quote = char;
        quoted = true;
        continue;
      }
      if (char === "\\") {
        at++;
        if (at === text.length) break;
        char = text[at] ?? "";
      }
      word += char;
    }
    if (word === "--") return { flags, rest: text.slice(at) };
    if (quoted || word !== "") flags.push(word);
  }
}

// An image named with its digest, whose content the name fixes.
const PINNED = /@sha256:[0-9a-f]{64}$/;

/**
 * What a COPY copies from, as Docker resolves its --from: the build context (undefined, without
 * one or with an empty one), the stage at that index or of that name (in any case), or an image
 * pinned by its digest. Anything else, a --from given twice and one Docker would expand further,
 * is refused.
 */
function copySource(copy: Instruction, stages: readonly Stage[]): Stage | "image" | undefined {
  const values = builderFlags(copy.text)
    .flags.filter((flag) => flag === "--from" || flag.startsWith("--from="))
    .map((flag) => flag.slice("--from=".length));
  if (values.length > 1) fail(`COPY on line ${copy.line} gives --from ${values.length} times`);
  const [value] = values;
  if (value === undefined || value === "") return undefined;
  if (!/^[\w.:/@+-]+$/.test(value)) {
    fail(
      `COPY on line ${copy.line} gives --from as ${JSON.stringify(value)}, which the test does not read`,
    );
  }
  const index = /^[+-]?\d+$/.test(value) ? Number(value) : undefined;
  const stage =
    index === undefined
      ? stages.find((each) => each.name === value.toLowerCase())
      : index >= 0 && index < stages.length
        ? stages[index]
        : undefined;
  if (stage !== undefined) return stage;
  if (index === undefined && PINNED.test(value)) return "image";
  fail(
    `COPY on line ${copy.line} copies from ${JSON.stringify(value)}, which is neither a stage of the file nor an image pinned by digest`,
  );
}

// A stage's name as Docker accepts one, in lower case.
const STAGE_NAME = /^[a-z][a-z0-9_.-]*$/;

function stagesOf(instructions: readonly Instruction[]): Stage[] {
  const stages: Stage[] = [];
  const bases: { base: string; line: number }[] = [];
  for (const instruction of instructions) {
    if (instruction.keyword === "ONBUILD") {
      fail(
        `ONBUILD on line ${instruction.line} gives instructions to the stages built on its own, which the test does not read`,
      );
    }
    if (instruction.keyword === "FROM") {
      const words = dockerWords(instruction.text, {}).filter((w) => !w.startsWith("--platform="));
      const [base, as, name] = words;
      if (
        base === undefined ||
        (words.length !== 1 && (words.length !== 3 || as?.toUpperCase() !== "AS"))
      ) {
        fail(`FROM on line ${instruction.line} is not \`FROM <image> [AS <name>]\``);
      }
      if (name !== undefined) {
        // Docker reads a stage name in any case, refuses one that is not of this form, and lets a
        // later stage of a name replace an earlier one (with a warning only): the reader, which
        // would read the first, refuses a name used twice.
        if (!STAGE_NAME.test(name.toLowerCase())) {
          fail(
            `FROM on line ${instruction.line} names its stage ${JSON.stringify(name)}, which Docker refuses as a stage's name`,
          );
        }
        const earlier = stages.findIndex((each) => each.name === name.toLowerCase());
        if (earlier !== -1) {
          fail(
            `FROM on line ${instruction.line} names the stage ${name.toLowerCase()} again (the FROM on line ${bases[earlier]?.line} names it first), which the test refuses: Docker would read the last stage of a name`,
          );
        }
      }
      stages.push({
        name: (name ?? String(stages.length)).toLowerCase(),
        parent: undefined,
        instructions: [],
        repository: false,
      });
      bases.push({ base: base.toLowerCase(), line: instruction.line });
      continue;
    }
    const stage = stages.at(-1);
    if (stage === undefined) {
      if (instruction.keyword === "ARG") continue;
      fail(`${instruction.keyword} on line ${instruction.line} comes before any FROM`);
    }
    stage.instructions.push(instruction);
  }
  for (const [index, stage] of stages.entries()) {
    const { base, line } = bases[index] ?? { base: "", line: 0 };
    const parent = stages.findIndex((each) => each.name === base);
    if (parent >= index) {
      fail(`FROM on line ${line} names the stage ${base}, which is not before it`);
    }
    stage.parent = stages[parent];
  }
  // A copy may name a stage after its own, so what each stage holds is settled over all of them.
  const sources = new Map<Instruction, Stage | "image" | undefined>();
  for (const stage of stages) {
    for (const instruction of stage.instructions) {
      if (instruction.keyword === "COPY") sources.set(instruction, copySource(instruction, stages));
    }
  }
  const holds = (instruction: Instruction): boolean => {
    if (instruction.keyword === "ADD" || instruction.keyword === "RUN") return true;
    if (instruction.keyword !== "COPY") return false;
    const source = sources.get(instruction);
    return source === undefined || (source !== "image" && source.repository);
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const stage of stages) {
      if (stage.repository) continue;
      stage.repository = stage.parent?.repository === true || stage.instructions.some(holds);
      changed ||= stage.repository;
    }
  }
  return stages;
}

/** The stages `stage` is built on, the first first, and `stage` itself last. */
const chain = (stage: Stage): Stage[] =>
  stage.parent === undefined ? [stage] : [...chain(stage.parent), stage];

const SHELLS = [
  ["/bin/sh", "-c"],
  ["/bin/bash", "-c"],
  ["/bin/bash", "-o", "pipefail", "-c"],
];

/** What a stage's instructions have set up: its environment, working directory and shell. */
interface Setting {
  env: Record<string, string>;
  workdir: string;
  shell: string[];
}

/**
 * The environment, working directory and shell of `stage` at its instruction `until`: the ENV,
 * WORKDIR and SHELL of each stage it is built on and its own, and its own ARGs, the build argument
 * `arg` among them set to `value` (a build argument does not cross stages).
 */
function settingOf(
  stage: Stage,
  until: Instruction,
  arg: string | undefined,
  value: string | undefined,
): Setting {
  const setting: Setting = { env: {}, workdir: "/", shell: ["/bin/sh", "-c"] };
  for (const each of chain(stage)) {
    for (const instruction of each.instructions) {
      if (instruction === until) return setting;
      if (instruction.keyword === "ENV") {
        for (const word of dockerWords(instruction.text, setting.env)) {
          const at = word.indexOf("=");
          if (at <= 0 || !NAME.test(word.slice(0, at))) {
            fail(`ENV on line ${instruction.line} is not \`ENV NAME=value ...\``);
          }
          setting.env[word.slice(0, at)] = word.slice(at + 1);
        }
      } else if (instruction.keyword === "WORKDIR") {
        const [directory, ...more] = dockerWords(instruction.text, setting.env);
        if (directory === undefined || more.length > 0) {
          fail(`WORKDIR on line ${instruction.line} names no one directory`);
        }
        setting.workdir = posix.resolve(setting.workdir, directory);
      } else if (instruction.keyword === "SHELL") {
        let shell: unknown;
        try {
          shell = JSON.parse(instruction.text);
        } catch {
          fail(`SHELL on line ${instruction.line} is not JSON`);
        }
        if (!Array.isArray(shell) || !shell.every((part) => typeof part === "string")) {
          fail(`SHELL on line ${instruction.line} is no list of strings`);
        }
        setting.shell = shell;
      } else if (instruction.keyword === "ARG" && each === stage) {
        for (const word of dockerWords(instruction.text, setting.env)) {
          const at = word.indexOf("=");
          const name = at === -1 ? word : word.slice(0, at);
          if (!NAME.test(name)) fail(`ARG on line ${instruction.line} declares no name`);
          if (name === arg && value !== undefined) setting.env[name] = value;
          else if (at !== -1) setting.env[name] = word.slice(at + 1);
        }
      }
    }
  }
  fail(`the instruction on line ${until.line} is not in its stage`);
}

/** The names of the build arguments a stage declares, in order. */
const argsOf = (stage: Stage): string[] =>
  stage.instructions
    .filter((instruction) => instruction.keyword === "ARG")
    .flatMap((instruction) => dockerWords(instruction.text, {}))
    .map((word) => word.split("=")[0] ?? "");

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Whether `path` is made of plain characters only, with no `.` or `..` segment. */
const plainPath = (path: string): boolean =>
  /^[\w.@+/-]+$/.test(path) && !path.split("/").some((part) => part === "." || part === "..");

/** The words of `command` when it is one simple command of plain words, not led by an assignment. */
function commandWords(command: string): string[] | undefined {
  let steps: string[][];
  try {
    steps = shellSteps(command, {});
  } catch (error) {
    if (error instanceof Unreadable) return undefined;
    throw error;
  }
  const [words, ...more] = steps;
  if (words === undefined || more.length > 0 || ASSIGNMENT.test(words[0] ?? "")) return undefined;
  return words;
}

/**
 * The allowlist (ALLOWLIST_FILE) in `repository`: an object of exactly `about`, `copies` and
 * `preScripts`; each copy an object of exactly a Dockerfile directly under ops/docker (by its
 * repository path), a stage's name (in lower case), an absolute source and destination, the one
 * command of plain words that makes the source in that stage, and a reason; each pre-script an
 * object of exactly a command, the repository path of the file it writes and a reason; every value
 * a string with text. Anything else, a missing file included, is refused, which refuses every
 * build.
 */
export function readAllowlist(repository: string): Allowlist {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(repository, ALLOWLIST_FILE), "utf8"));
  } catch {
    fail("it is missing or is not JSON");
  }
  const fields = (item: unknown, keys: readonly string[], what: string) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      fail(`${what} is not an object`);
    }
    const found = Object.keys(item).sort();
    if (JSON.stringify(found) !== JSON.stringify([...keys].sort())) {
      fail(`${what} holds ${found.join(", ") || "nothing"}, not exactly ${keys.join(", ")}`);
    }
    return item as Record<string, unknown>;
  };
  const text = (item: Record<string, unknown>, key: string, what: string): string => {
    const field = item[key];
    if (typeof field !== "string" || field.trim() === "") {
      fail(`${what}'s ${key} is not a string with text`);
    }
    return field;
  };
  const list = (item: Record<string, unknown>, key: string): unknown[] => {
    const field = item[key];
    if (!Array.isArray(field)) fail(`its ${key} is not a list`);
    return field;
  };
  const top = fields(value, ["about", "copies", "preScripts"], "it");
  text(top, "about", "it");
  const copies = list(top, "copies").map((item, index): AllowedCopy => {
    const what = `copy ${index + 1}`;
    const entry = fields(
      item,
      ["dockerfile", "stage", "source", "destination", "produces", "reason"],
      what,
    );
    const copy = {
      dockerfile: text(entry, "dockerfile", what),
      stage: text(entry, "stage", what),
      source: text(entry, "source", what),
      destination: text(entry, "destination", what),
      produces: text(entry, "produces", what),
      reason: text(entry, "reason", what),
    };
    if (
      !plainPath(copy.dockerfile) ||
      posix.dirname(copy.dockerfile) !== DOCKER_DIRECTORY ||
      !copy.dockerfile.endsWith(".Dockerfile")
    ) {
      fail(
        `${what}'s dockerfile, ${JSON.stringify(copy.dockerfile)}, is not a Dockerfile of ${DOCKER_DIRECTORY}`,
      );
    }
    if (!STAGE_NAME.test(copy.stage)) {
      fail(`${what}'s stage, ${JSON.stringify(copy.stage)}, is not a stage's name in lower case`);
    }
    for (const path of [copy.source, copy.destination]) {
      if (!posix.isAbsolute(path) || !plainPath(path)) {
        fail(`${what}'s ${JSON.stringify(path)} is not an absolute path in plain characters`);
      }
    }
    if (commandWords(copy.produces) === undefined) {
      fail(
        `${what}'s produces, ${JSON.stringify(copy.produces)}, is not one command of plain words`,
      );
    }
    return copy;
  });
  const preScripts = list(top, "preScripts").map((item, index): AllowedPreScript => {
    const what = `pre-script ${index + 1}`;
    const entry = fields(item, ["command", "writes", "reason"], what);
    const pre = {
      command: text(entry, "command", what),
      writes: text(entry, "writes", what),
      reason: text(entry, "reason", what),
    };
    if (posix.isAbsolute(pre.writes) || !plainPath(pre.writes)) {
      fail(`${what}'s writes, ${JSON.stringify(pre.writes)}, is not a repository path`);
    }
    return pre;
  });
  return { copies, preScripts };
}

/** A workspace package: its repository path and its manifest's name. */
interface WorkspacePackage {
  path: string;
  name: unknown;
}

/** The workspace's packages (pnpm-workspace.yaml's `packages:`), as vitest.config.ts reads them. */
function workspacePackages(repository: string): WorkspacePackage[] {
  const lines = readFileSync(join(repository, "pnpm-workspace.yaml"), "utf8").split("\n");
  const start = lines.indexOf("packages:");
  const globs: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    const item = /^ {2}- (\S+)$/.exec(line);
    if (item?.[1] === undefined) break;
    globs.push(item[1]);
  }
  return globs
    .flatMap((glob) => globSync(glob, { cwd: repository }))
    .map((path) => path.split("\\").join("/"))
    .filter((path) => existsSync(join(repository, path, "package.json")))
    .sort()
    .map((path) => ({ path, name: readJson(join(repository, path, "package.json")).name }));
}

// pnpm's settings that change how it runs a script or what Node it gives the script: refused, since
// the test starts the build itself and does not reproduce them.
const SCRIPT_SETTINGS = ["nodeOptions", "scriptShell", "shellEmulator"];

/** Refuses the workspace's pnpm settings that change how pnpm runs a script. */
function checkPnpmSettings(repository: string, pkg: string): void {
  const workspace = readFileSync(join(repository, "pnpm-workspace.yaml"), "utf8");
  for (const setting of SCRIPT_SETTINGS) {
    if (new RegExp(`^${setting}\\s*:`, "m").test(workspace)) {
      fail(`pnpm-workspace.yaml sets ${setting}, which changes how pnpm runs the script`);
    }
  }
  for (const dir of new Set(["", pkg])) {
    const npmrc = posix.join(dir, ".npmrc");
    if (existsSync(join(repository, npmrc))) fail(`${npmrc} can change how pnpm runs the script`);
  }
}

/**
 * The config file of the script `script` among `scripts`: the script must be exactly `vite build
 * --config <file>`, the file a relative path in plain characters, and there may be no `post` script
 * of its name and no `pre` script but one that is byte for byte one of `preScripts` (the commands
 * the allowlist names), which pnpm runs around it.
 */
export function viteBuildConfig(
  scripts: Readonly<Record<string, unknown>>,
  script: string,
  preScripts: readonly string[] = [],
): string {
  const pre = `pre${script}`;
  if (pre in scripts && !preScripts.some((command) => command === scripts[pre])) {
    fail(`the package has a ${pre} script, which pnpm runs with ${script}`);
  }
  const post = `post${script}`;
  if (post in scripts) fail(`the package has a ${post} script, which pnpm runs with ${script}`);
  const command = scripts[script];
  const words = typeof command === "string" ? command.trim().split(/\s+/) : [];
  const [vite, build, flag, file] = words;
  if (
    words.length !== 4 ||
    vite !== "vite" ||
    build !== "build" ||
    flag !== "--config" ||
    file === undefined ||
    !/^[\w.@+][\w./@+-]*$/.test(file)
  ) {
    fail(
      `its ${script} script, ${JSON.stringify(command)}, is not exactly \`vite build --config <file>\``,
    );
  }
  return file;
}

/** An allowlisted copy's stage, read: the stage, its entry, and the directory its steps run in. */
interface ScannedStage {
  stage: Stage;
  entry: AllowedCopy;
  workdir: string;
}

/** A Dockerfile's release build, read once: what evaluating it for each app needs. */
interface Release {
  dockerfile: string;
  build: Stage;
  release: Stage;
  run: Instruction;
  copy: Instruction;
  /** The build stage's build argument (the app), when it declares one. */
  arg: string | undefined;
  /** The stages of the allowlisted copies the release stage takes, each read by checkScanned. */
  scanned: ScannedStage[];
}

/**
 * The allowlist's copy that `copy`, in the Dockerfile `dockerfile` and from `source` (a stage that
 * holds the repository), is: an entry for that Dockerfile, --from its only flag, and its words
 * exactly the entry's source and destination, with nothing expanded. Otherwise undefined, and the
 * copy counts as a copy of the bundle.
 */
function allowedCopy(
  dockerfile: string,
  copy: Instruction,
  source: Stage,
  allowlist: Allowlist,
): AllowedCopy | undefined {
  const { flags, rest } = builderFlags(copy.text);
  if (flags.length !== 1) return undefined;
  let words: string[];
  try {
    words = dockerWords(rest, {});
  } catch (error) {
    if (error instanceof Unreadable) return undefined;
    throw error;
  }
  const [from, to, ...more] = words;
  if (more.length > 0) return undefined;
  return allowlist.copies.find(
    (entry) =>
      entry.dockerfile === dockerfile &&
      entry.stage === source.name &&
      entry.source === from &&
      entry.destination === to,
  );
}

/** An allowlisted copy's stage, as its refusals name it. */
const scannedName = (stage: Stage, entry: AllowedCopy): string =>
  `its stage ${stage.name}, which ${ALLOWLIST_FILE} lets the ${RELEASE_STAGE} stage copy ${entry.source} from,`;

/**
 * Refuses an allowlisted copy unless its stage makes exactly what it copies and scans it: the stage
 * gives no instruction but RUN, each a plain shell command, in a shell the test reads; its last RUN's
 * last step is exactly the image's output scan over the copy's source; and its steps, across its
 * RUNs (each RUN a list of steps joined by `&&`), are exactly two: the entry's `produces`, word for
 * word, and then that scan. So nothing but the command the allowlist names writes what the release
 * stage copies, nothing the stage does comes before or after the scan, and the scan's failure fails
 * the image's build. An ARG, ENV, WORKDIR or SHELL of the stage's own, which would change what its
 * steps run or where, is refused; the stage it is built on and the directory it runs in are held to
 * the bundle's build stage's by the caller. Returns the directory its steps run in.
 */
function checkScanned(stage: Stage, entry: AllowedCopy): string {
  const which = scannedName(stage, entry);
  for (const instruction of stage.instructions) {
    if (!["ARG", "ENV", "WORKDIR", "SHELL", "RUN"].includes(instruction.keyword)) {
      fail(`${which} has ${instruction.keyword} on line ${instruction.line}`);
    }
    if (instruction.keyword === "RUN" && /^\s*(?:\[|--)/.test(instruction.text)) {
      fail(`${which} has a RUN on line ${instruction.line} that is not a plain shell command`);
    }
  }
  const directory = posix.resolve(entry.source);
  const last = stage.instructions.at(-1);
  const refusal = `${which} does not end in a RUN whose last step is \`node ${SCAN_SCRIPT} ${directory}\``;
  if (last?.keyword !== "RUN") fail(refusal);
  const { env, workdir, shell } = settingOf(stage, last, undefined, undefined);
  if (!SHELLS.some((known) => JSON.stringify(known) === JSON.stringify(shell))) {
    fail(`${which} runs its RUN in ${JSON.stringify(shell)}, not a shell the test reads`);
  }
  const scan = shellSteps(last.text, env).at(-1) ?? [];
  const [node, script, scanned, ...more] = scan;
  if (
    node !== "node" ||
    script !== SCAN_SCRIPT ||
    scanned === undefined ||
    more.length > 0 ||
    posix.resolve(workdir, scanned) !== directory
  ) {
    fail(refusal);
  }
  // Before the scan, as after it: nothing of the stage's own but its RUNs, and in them nothing but
  // the command that makes the copy and then the scan.
  for (const instruction of stage.instructions) {
    if (instruction.keyword !== "RUN") {
      fail(`${which} has ${instruction.keyword} on line ${instruction.line}`);
    }
  }
  const steps = stage.instructions.flatMap((run) => shellSteps(run.text, env));
  const [made, ...rest] = steps;
  if (
    made === undefined ||
    rest.length !== 1 ||
    JSON.stringify(made) !== JSON.stringify(commandWords(entry.produces))
  ) {
    fail(
      `${which} does not run exactly \`${entry.produces}\` and then \`node ${SCAN_SCRIPT} ${directory}\`, with no other step`,
    );
  }
  return workdir;
}

/**
 * Reads the release stage and its build stage of the Dockerfile at the repository path given: the
 * one copy of the bundle, from a stage that holds the repository, and beside it only the copies
 * `allowlist` names for this Dockerfile, each from a stage that makes exactly it and scans it, built
 * on the stage the bundle's build stage is built on (so it starts from the same repository).
 */
function readRelease(repository: string, dockerfile: string, allowlist: Allowlist): Release {
  const stages = stagesOf(dockerInstructions(readFileSync(join(repository, dockerfile), "utf8")));
  const release = stages.find((stage) => stage.name === RELEASE_STAGE);
  if (release === undefined) fail(`it has no \`${RELEASE_STAGE}\` stage`);
  if (release.parent?.repository === true) {
    fail(
      `its ${RELEASE_STAGE} stage is built on ${release.parent.name}, which holds the repository`,
    );
  }
  const copies: { copy: Instruction; build: Stage }[] = [];
  const scanned: ScannedStage[] = [];
  for (const instruction of release.instructions) {
    if (instruction.keyword === "RUN" || instruction.keyword === "ADD") {
      fail(`its ${RELEASE_STAGE} stage has ${instruction.keyword} on line ${instruction.line}`);
    }
    if (instruction.keyword !== "COPY") continue;
    const source = copySource(instruction, stages);
    if (source === undefined) {
      fail(`its ${RELEASE_STAGE} stage copies from the build context on line ${instruction.line}`);
    }
    if (source === "image" || !source.repository) continue;
    const allowed = allowedCopy(dockerfile, instruction, source, allowlist);
    if (allowed === undefined) copies.push({ copy: instruction, build: source });
    else {
      scanned.push({ stage: source, entry: allowed, workdir: checkScanned(source, allowed) });
    }
  }
  const [first, ...more] = copies;
  if (first === undefined || more.length > 0) {
    fail(
      `its ${RELEASE_STAGE} stage copies ${copies.length} times from stages that hold the repository, not once`,
    );
  }
  const { copy, build } = first;
  for (const instruction of build.instructions) {
    if (!["ARG", "ENV", "WORKDIR", "SHELL", "RUN"].includes(instruction.keyword)) {
      fail(`its build stage ${build.name} has ${instruction.keyword} on line ${instruction.line}`);
    }
  }
  const runs = build.instructions.filter((instruction) => instruction.keyword === "RUN");
  const [run, ...others] = runs;
  if (run === undefined || others.length > 0) {
    fail(`its build stage ${build.name} has ${runs.length} RUN instructions, not one`);
  }
  if (/^\s*(?:\[|--)/.test(run.text)) {
    fail(`its build stage's RUN on line ${run.line} is not a plain shell command`);
  }
  const args = argsOf(build);
  if (args.length > 1)
    fail(`its build stage ${build.name} declares ${args.length} build arguments`);
  for (const { stage, entry } of scanned) {
    if (build.parent === undefined) {
      fail(
        `${scannedName(stage, entry)} has no stage in common with the bundle's build stage ${build.name}, which is built on an image`,
      );
    }
    if (stage.parent !== build.parent) {
      fail(
        `${scannedName(stage, entry)} is built on ${stage.parent?.name ?? "an image"}, not on ${build.parent.name}, the stage the bundle's build stage ${build.name} is built on`,
      );
    }
  }
  return { dockerfile, build, release, run, copy, arg: args[0], scanned };
}

/** The directory the release stage copies, with the build argument set to `value`. */
function copiedDirectory(release: Release, value: string | undefined): string {
  const { env } = settingOf(release.release, release.copy, release.arg, value);
  const words = dockerWords(builderFlags(release.copy.text).rest, env);
  const [source, destination, ...more] = words;
  if (source === undefined || destination === undefined || more.length > 0) {
    fail(`its ${RELEASE_STAGE} stage's COPY on line ${release.copy.line} is not one source`);
  }
  if (!posix.isAbsolute(source)) {
    fail(`its ${RELEASE_STAGE} stage's COPY on line ${release.copy.line} names a relative source`);
  }
  return posix.resolve(source);
}

const labelOf = (release: Release, value: string | undefined): string =>
  release.arg === undefined || value === undefined
    ? release.dockerfile
    : `${release.dockerfile}, ${release.arg}=${value}`;

/** The build step of a RUN: its assignments, the package filter and the script. */
interface BuildStep {
  index: number;
  assignments: Record<string, string>;
  filter: string;
  script: string;
}

/**
 * Reads one Dockerfile's release build with the build argument set to `value`: the build step, the
 * scan right after it over the directory the release stage copies, and the package and script pnpm
 * runs, with the pre-script `allowlist` lets pnpm run before it. Returns the build, or why it is
 * skipped (pnpm builds nothing, so the image does not build).
 */
function evaluate(
  repository: string,
  release: Release,
  value: string | undefined,
  packages: readonly WorkspacePackage[],
  allowlist: Allowlist,
): ImageBuild | { skipped: string } {
  const { env, workdir, shell } = settingOf(release.build, release.run, release.arg, value);
  // An allowlisted copy's stage runs its command and the scan (both repository paths) where the
  // bundle's build stage runs pnpm, the repository's root, so they are the repository's files.
  for (const each of release.scanned) {
    if (each.workdir !== workdir) {
      fail(
        `${scannedName(each.stage, each.entry)} runs in ${each.workdir}, not in ${workdir}, where the bundle's build stage ${release.build.name} runs pnpm`,
      );
    }
  }
  if (!SHELLS.some((known) => JSON.stringify(known) === JSON.stringify(shell))) {
    fail(`its build stage's shell, ${JSON.stringify(shell)}, is not one the test reads`);
  }
  let build: BuildStep | undefined;
  let scan: { index: number; directory: string } | undefined;
  for (const [index, words] of shellSteps(release.run.text, env).entries()) {
    if (words[0] === "test") continue;
    const assigned = words.findIndex((word) => !ASSIGNMENT.test(word));
    if (assigned === -1) fail(`its RUN holds a step of assignments alone: \`${words.join(" ")}\``);
    const command = words.slice(assigned);
    if (command[0] === "pnpm") {
      const [, flag, filter, run, script, ...rest] = command;
      if (
        flag !== "--filter" ||
        run !== "run" ||
        filter === undefined ||
        script === undefined ||
        rest.length > 0
      ) {
        fail(
          `its build step \`${words.join(" ")}\` is not \`pnpm --filter <package> run <script>\``,
        );
      }
      if (build !== undefined) fail("its RUN holds a second pnpm step");
      const assignments: Record<string, string> = {};
      for (const word of words.slice(0, assigned)) {
        const at = word.indexOf("=");
        assignments[word.slice(0, at)] = word.slice(at + 1);
      }
      build = { index, assignments, filter, script };
    } else if (assigned === 0 && command[0] === "node" && command[1] === SCAN_SCRIPT) {
      const directory = command[2];
      if (directory === undefined || command.length !== 3) {
        fail(`its scan step \`${words.join(" ")}\` names no one directory`);
      }
      if (scan !== undefined) fail("its RUN holds a second scan step");
      scan = { index, directory: posix.resolve(workdir, directory) };
    } else {
      fail(`its RUN holds a step the test cannot read: \`${words.join(" ")}\``);
    }
  }
  if (build === undefined) fail("its RUN holds no `pnpm --filter <package> run <script>` step");
  if (scan === undefined) fail(`its RUN does not run ${SCAN_SCRIPT} over the build's output`);
  if (scan.index !== build.index + 1) {
    fail(`its RUN does not run ${SCAN_SCRIPT} right after the build step`);
  }
  const copied = copiedDirectory(release, value);
  if (scan.directory !== copied) {
    fail(`its RUN scans ${scan.directory}, but its ${RELEASE_STAGE} stage copies ${copied}`);
  }
  const { filter, script } = build;
  if (!/^@fin\/[\w.-]+$/.test(filter)) {
    fail(`its filter ${JSON.stringify(filter)} is not one package's name`);
  }
  const selected = packages.filter((each) => each.name === filter);
  const [chosen, ...also] = selected;
  if (chosen === undefined) return { skipped: `${filter} is no workspace package` };
  if (also.length > 0) fail(`${selected.length} workspace packages are named ${filter}`);
  const output = posix.relative(workdir, copied);
  if (!output.startsWith(`${chosen.path}/`)) {
    fail(`it copies ${copied}, which is not under ${chosen.path}, the package pnpm builds`);
  }
  const directory = join(repository, chosen.path);
  const manifest = readJson(join(directory, "package.json"));
  const scripts =
    typeof manifest.scripts === "object" && manifest.scripts !== null
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  if (!(script in scripts)) return { skipped: `${chosen.path} has no ${script} script` };
  checkPnpmSettings(repository, chosen.path);
  const config = viteBuildConfig(
    scripts,
    script,
    allowlist.preScripts.map((entry) => entry.command),
  );
  const pre = allowlist.preScripts.find((entry) => entry.command === scripts[`pre${script}`]);
  return {
    label: labelOf(release, value),
    dockerfile: release.dockerfile,
    package: chosen.path,
    directory,
    script,
    command: String(scripts[script]),
    configFile: resolve(directory, config),
    preScript: pre === undefined ? undefined : { command: pre.command, writes: pre.writes },
    environment: { ...env, ...build.assignments },
    output,
    shell,
    run: release.run.text,
  };
}

/** The apps a build argument may name: each directory under apps/ that holds a package. */
function appNames(repository: string): string[] {
  const apps = join(repository, "apps");
  if (!existsSync(apps)) return [];
  return readdirSync(apps, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(apps, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Runs the image's output scan (`repository`'s ops/docker/harness-scan.mjs) over `dir` as a build
 * step runs it, with `node` and no exec arguments and only PATH in its environment: its exit status
 * and what it printed.
 */
export function runHarnessScan(
  repository: string,
  dir: string,
): { status: number | null; stdout: string; stderr: string } {
  const scan = spawnSync(process.execPath, [join(repository, SCAN_SCRIPT), dir], {
    cwd: repository,
    encoding: "utf8",
    env: { PATH: dirname(process.execPath) },
  });
  if (scan.error !== undefined) throw scan.error;
  return { status: scan.status, stdout: scan.stdout, stderr: scan.stderr };
}

/**
 * Every release server build the Dockerfiles under ops/docker run, for each app their build
 * argument may name, with each refusal and each pairing that builds nothing. An allowlist that
 * cannot be read refuses every build.
 */
export function imageBuilds(repository: string): ImageBuilds {
  const result: ImageBuilds = { builds: [], refusals: [], skipped: [] };
  let allowlist: Allowlist;
  try {
    allowlist = readAllowlist(repository);
  } catch (error) {
    if (!(error instanceof Unreadable)) throw error;
    result.refusals.push(`${ALLOWLIST_FILE}: ${error.message}`);
    return result;
  }
  const packages = workspacePackages(repository);
  const dockerfiles = globSync("*.Dockerfile", { cwd: join(repository, DOCKER_DIRECTORY) })
    .map((name) => `${DOCKER_DIRECTORY}/${name}`)
    .sort();
  for (const dockerfile of dockerfiles) {
    let release: Release;
    try {
      release = readRelease(repository, dockerfile, allowlist);
    } catch (error) {
      if (!(error instanceof Unreadable)) throw error;
      result.refusals.push(`${dockerfile}: ${error.message}`);
      continue;
    }
    const values = release.arg === undefined ? [undefined] : appNames(repository);
    for (const value of values) {
      try {
        const build = evaluate(repository, release, value, packages, allowlist);
        if ("skipped" in build) result.skipped.push(`${labelOf(release, value)}: ${build.skipped}`);
        else result.builds.push(build);
      } catch (error) {
        if (!(error instanceof Unreadable)) throw error;
        result.refusals.push(`${labelOf(release, value)}: ${error.message}`);
      }
    }
  }
  return result;
}
