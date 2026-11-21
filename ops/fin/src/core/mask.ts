// Masking (spec 01 §9.2): every private value `pnpm fin` learns (each overlay value, each
// credential, each ID it resolves at run time) is registered here before anything is printed, and
// every line that leaves the process passes through mask(). A value is replaced by a placeholder
// that names its role (`<zone>`, `<host:console>`, `<overlay:cloudflare.accountId>`), so the output
// stays readable and carries nothing private.
//
// A value is registered in every form it can take in output: as written, URL-encoded (an address
// in a query string), JSON-escaped (a value with a quote, a backslash or a newline inside a JSON
// text), and, for a value of several lines, each line on its own (output is read line by line).
// Records and telemetry lines are masked value by value (maskValue) before they are serialised, so
// masking never rewrites JSON syntax.
//
// GitHub masks only whole registered values, line by line, so in GitHub Actions every form is also
// announced with `::add-mask::` before the first line is printed (addMaskCommands); the command
// data is escaped the way the runner unescapes it.

/** Values shorter than this cannot carry private information on their own (`@`, `*`, `5`). */
const MIN_LENGTH = 2;
/** From this length, each line of a multi-line value (with a letter or digit) is its own form. */
const MIN_LINE_LENGTH = 3;
/** Values shorter than this are masked only as whole tokens, so ordinary words survive. */
const TOKEN_ONLY_BELOW = 6;
const DIGITS = /^\d+$/;

interface Entry {
  value: string;
  placeholder: string;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/** The data of a workflow command, escaped as the runner unescapes it (`%`, CR and LF). */
export function escapeCommandData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** The forms a value can take in output (see the header). */
function formsOf(value: string): string[] {
  const forms = new Set<string>([value]);
  const lines = value.split(/\r\n|\r|\n/);
  if (lines.length > 1) {
    for (const line of lines.map((l) => l.trim())) {
      if (line.length >= MIN_LINE_LENGTH && /[A-Za-z0-9]/.test(line)) forms.add(line);
    }
  }
  for (const form of [...forms]) {
    forms.add(encodeURIComponent(form));
    forms.add(JSON.stringify(form).slice(1, -1));
  }
  return [...forms].filter((form) => form.length >= MIN_LENGTH);
}

export class Masker {
  readonly #entries = new Map<string, Entry>();
  #pattern: RegExp | undefined;

  /**
   * Registers a private value in all its forms. A number is registered as its decimal text; a
   * short all-digit value is masked only where it stands as a number of its own (not inside a
   * date, a time, an address or a longer number), and a registered number in a JSON value is
   * masked by maskValue(). A form already registered keeps its first placeholder.
   */
  register(value: string | number, placeholder: string): void {
    const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
    if (text.length < MIN_LENGTH) return;
    for (const form of formsOf(text)) {
      const key = form.toLowerCase();
      if (this.#entries.has(key)) continue;
      this.#entries.set(key, { value: form, placeholder });
      this.#pattern = undefined;
    }
  }

  /** How many forms are registered (for the dry-run summary and the tests). */
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

  /**
   * A masked copy of a JSON value, for a record or a telemetry line: every string in it, keys
   * included, passes through mask(); a number that is a registered value becomes its placeholder;
   * a value with a toJSON (a Secret) becomes what it prints. Everything else and the structure are
   * kept, so the copy always serialises to valid JSON: masking never touches JSON's own syntax.
   */
  maskValue(value: unknown): unknown {
    let plain: unknown;
    try {
      plain = JSON.parse(JSON.stringify(value) ?? "null");
    } catch {
      return "<unprintable>";
    }
    return this.#walk(plain);
  }

  #walk(value: unknown): unknown {
    if (typeof value === "string") return this.mask(value);
    if (typeof value === "number") return this.#entries.get(String(value))?.placeholder ?? value;
    if (Array.isArray(value)) return value.map((item) => this.#walk(item));
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        Object.defineProperty(out, this.mask(key), {
          value: this.#walk(item),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return value;
  }

  /** The GitHub Actions commands that register every form with the runner's own masking. */
  addMaskCommands(): string[] {
    return [...this.#entries.values()].map(
      (entry) => `::add-mask::${escapeCommandData(entry.value)}`,
    );
  }

  #compile(): RegExp {
    if (this.#pattern !== undefined) return this.#pattern;
    const alternatives = [...this.#entries.values()]
      .sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value))
      .map((entry) => {
        const body = escapeRegExp(entry.value);
        if (entry.value.length >= TOKEN_ONLY_BELOW) return body;
        if (DIGITS.test(entry.value)) {
          // A short number only where it stands on its own: not inside a word, a longer number, a
          // date, a time, a version or an address.
          return `(?<![0-9A-Za-z_])(?<![0-9][.:-])${body}(?![0-9A-Za-z_])(?![.:-][0-9])`;
        }
        return `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`;
      });
    this.#pattern = new RegExp(alternatives.join("|"), "gi");
    return this.#pattern;
  }
}
