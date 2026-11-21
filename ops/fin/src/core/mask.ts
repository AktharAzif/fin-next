// Masking (spec 01 §9.2): every private value `pnpm fin` learns (each overlay value, each
// credential, each ID it resolves at run time) is registered here before anything is printed, and
// every line that leaves the process passes through mask(). A value is replaced by a placeholder
// that names its role (`<zone>`, `<host:console>`, `<cloudflare.zoneId>`), so the output stays
// readable and carries nothing private.
//
// GitHub masks only whole registered values, so in GitHub Actions every value is also announced
// with `::add-mask::` before the first line is printed (addMaskCommands).

/** Values shorter than this cannot carry private information on their own (`@`, `*`). */
const MIN_LENGTH = 2;
/** Values shorter than this are masked only as whole tokens, so ordinary words survive. */
const TOKEN_ONLY_BELOW = 6;

interface Entry {
  value: string;
  placeholder: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

export class Masker {
  readonly #entries = new Map<string, Entry>();
  #pattern: RegExp | undefined;

  /**
   * Registers a private value. Its URL-encoded form is registered too, so an address inside a
   * query string is masked as well. A value already registered keeps its first placeholder.
   */
  register(value: string, placeholder: string): void {
    if (value.length < MIN_LENGTH) return;
    for (const form of new Set([value, encodeURIComponent(value)])) {
      const key = form.toLowerCase();
      if (this.#entries.has(key)) continue;
      this.#entries.set(key, { value: form, placeholder });
      this.#pattern = undefined;
    }
  }

  /** How many values are registered (for the dry-run summary and the tests). */
  get size(): number {
    return this.#entries.size;
  }

  /** Whether the text still contains a registered value (used by the tests and the self-check). */
  leaks(text: string): boolean {
    return this.mask(text) !== text;
  }

  mask(text: string): string {
    if (this.#entries.size === 0 || text === "") return text;
    const pattern = this.#compile();
    pattern.lastIndex = 0;
    return text.replace(pattern, (match) => {
      return this.#entries.get(match.toLowerCase())?.placeholder ?? "<masked>";
    });
  }

  /** The GitHub Actions commands that register every value with the runner's own masking. */
  addMaskCommands(): string[] {
    return [...this.#entries.values()].map((entry) => `::add-mask::${entry.value}`);
  }

  #compile(): RegExp {
    if (this.#pattern !== undefined) return this.#pattern;
    const alternatives = [...this.#entries.values()]
      .sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value))
      .map((entry) => {
        const body = escapeRegExp(entry.value);
        return entry.value.length < TOKEN_ONLY_BELOW
          ? `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`
          : body;
      });
    this.#pattern = new RegExp(alternatives.join("|"), "gi");
    return this.#pattern;
  }
}
