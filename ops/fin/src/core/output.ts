// The only way `pnpm fin` prints. Every line passes through the masker, and in GitHub Actions the
// runner's own masking is primed with every registered value before the first line (spec 01 §9.2).
//
// The `::add-mask::` commands go to standard error, never standard output: they carry the values
// in clear for the runner to read, so standard output stays masked text that a workflow step may
// capture (into a variable, a file, a summary or a comment). The runner reads workflow commands on
// both streams. Standard error must never be captured.

import type { Masker } from "./mask.ts";
import type { Runtime } from "./runtime.ts";

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

  info(text: string): void {
    this.#prime();
    this.#runtime.stdout(`${this.#masker.mask(text)}\n`);
  }

  warn(text: string): void {
    this.#prime();
    this.#runtime.stderr(`warning: ${this.#masker.mask(text)}\n`);
  }

  error(text: string): void {
    this.#prime();
    this.#runtime.stderr(`error: ${this.#masker.mask(text)}\n`);
  }
}
