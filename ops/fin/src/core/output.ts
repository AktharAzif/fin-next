// The only way `pnpm fin` prints. Every line passes through the masker, and in GitHub Actions the
// runner's own masking is primed with every registered value before the first line (spec 01 §9.2).
//
// The `::add-mask::` commands go to standard error, never standard output: they carry the values
// in clear for the runner to read, so standard output stays masked text that a workflow step may
// capture (into a variable, a file, a summary or a comment). The runner reads workflow commands on
// both streams. Standard error must never be captured.
//
// One call prints exactly one line, and only Output's own `::add-mask::` lines are workflow
// commands. Text reaching a message can come from outside (an argument, the lock file, a provider's
// name or error), so after masking every control character and Unicode line or paragraph
// separator is written as a visible escape (`\n`, `\u001b`), which keeps a line from ending early
// or redrawing the terminal; a line whose first non-blank characters are `::` (a workflow command
// to the runner) gets a backslash before them, and so does the runner's older `##[` form wherever
// it appears. Without this, a printed `\n::stop-commands::<token>` would switch the runner's
// command processing off, and every later `::add-mask::` line would print its value in clear.

import type { Masker } from "./mask.ts";
import type { Runtime } from "./runtime.ts";

const NAMED_ESCAPES: Readonly<Record<number, string>> = { 9: "\\t", 10: "\\n", 13: "\\r" };

/** C0 controls, DEL, C1 controls, and the Unicode line and paragraph separators. */
function unsafe(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** The text as one printable line that the runner cannot read as a workflow command. */
export function oneLine(text: string): string {
  let escaped = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    escaped += unsafe(code)
      ? (NAMED_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`)
      : text.charAt(i);
  }
  return escaped.replace(/^(\s*)::/, "$1\\::").replaceAll("##[", "#\\#[");
}

export class Output {
  readonly #runtime: Pick<Runtime, "stdout" | "stderr" | "env">;
  readonly #masker: Masker;
  #announced = 0;

  constructor(runtime: Pick<Runtime, "stdout" | "stderr" | "env">, masker: Masker) {
    this.#runtime = runtime;
    this.#masker = masker;
  }

  get masker(): Masker {
    return this.#masker;
  }

  /** In GitHub Actions, registers every value added since the last call with `::add-mask::`. */
  #prime(): void {
    if (this.#runtime.env.GITHUB_ACTIONS !== "true") return;
    const commands = this.#masker.addMaskCommands();
    if (commands.length <= this.#announced) return;
    for (const command of commands.slice(this.#announced)) this.#runtime.stderr(`${command}\n`);
    this.#announced = commands.length;
  }

  /** The masked text as one safe line (masked first, so a value is matched as it was written). */
  #line(prefix: string, text: string): string {
    return `${oneLine(prefix + this.#masker.mask(text))}\n`;
  }

  info(text: string): void {
    this.#prime();
    this.#runtime.stdout(this.#line("", text));
  }

  warn(text: string): void {
    this.#prime();
    this.#runtime.stderr(this.#line("warning: ", text));
  }

  error(text: string): void {
    this.#prime();
    this.#runtime.stderr(this.#line("error: ", text));
  }
}
