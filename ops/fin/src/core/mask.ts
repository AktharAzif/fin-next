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
// GitHub masks only whole registered values, line by line, so in GitHub Actions every form of six
// characters or more is also announced with `::add-mask::` before the first line is printed
// (addMaskCommands); the command data is escaped the way the runner unescapes it. A shorter form is
// not announced: the runner masks inside words, so a short value would be masked all over the job
// log (in words and timestamps), which shows it; this masker masks it as a whole token instead.
//
// Numbers are not matched by value unless they are long. A short private number (a threshold, a
// grace period, a timing) equals some of the tool's own numbers sooner or later: a log seq, a step
// count, a plan's counts, a pid, a minute in a timestamp. Replacing those would corrupt them, and
// the placeholder would sit where the reader can tell the number from what surrounds it, which
// discloses the value; the runner's `::add-mask::`, which masks inside every word, would do the
// same to every timestamp in the job log. So a number of fewer than LONG_NUMBER characters is never
// registered: such a number is protected by its type instead (secret.ts's PrivateNumber prints its
// role, `<threshold:api-v4>`, and only reveal() gives the number to the request that sends it). A
// longer number (an ID) is masked only where it stands as a number of its own, and maskValue()
// never changes a JSON number: the numbers in records and lines are the tool's own.

/** Values shorter than this cannot carry private information on their own (`@`, `*`, `5`). */
const MIN_LENGTH = 2;
/** From this length, each line of a multi-line value (with a letter or digit) is its own form. */
const MIN_LINE_LENGTH = 3;
/** Values shorter than this are masked only as whole tokens, so ordinary words survive. */
const TOKEN_ONLY_BELOW = 6;
/** A number (as written) of at least this many characters is masked by value; a shorter one never. */
const LONG_NUMBER = 6;
/** A plain decimal number, as a number's text or a string holding one. */
const NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

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

/** Whether a value is a number too short to be masked by value (see the header). */
function shortNumber(text: string): boolean {
  return NUMBER.test(text) && text.length < LONG_NUMBER;
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
  return [...forms].filter((form) => form.length >= MIN_LENGTH && !shortNumber(form));
}

export class Masker {
  readonly #entries = new Map<string, Entry>();
  #pattern: RegExp | undefined;

  /**
   * Registers a private value in all its forms. A number, or a string holding only a number, is
   * registered only when it has at least LONG_NUMBER characters (see the header), and is then
   * masked only where it stands as a number of its own (not inside a word, a hash, a date, a time,
   * a version, an address or a longer number). A form already registered keeps its first
   * placeholder.
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
   * included, passes through mask(); a value with a toJSON (a Secret, a PrivateNumber) becomes
   * what it prints. Numbers, booleans, null and the structure are kept as they are (a record's
   * numbers are the tool's own: seqs, counts, pids), so the copy always serialises to valid JSON
   * with the same types: masking never touches JSON's own syntax.
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

  /**
   * The GitHub Actions commands that register every form with the runner's own masking. A form
   * shorter than TOKEN_ONLY_BELOW is left out: the runner masks a value inside every word of the
   * job log, so a short one would show up as `***` in ordinary words and timestamps across the
   * whole log, which names it to anyone reading it. This masker still masks it, as a whole token.
   */
  addMaskCommands(): string[] {
    return [...this.#entries.values()]
      .filter((entry) => entry.value.length >= TOKEN_ONLY_BELOW)
      .map((entry) => `::add-mask::${escapeCommandData(entry.value)}`);
  }

  #compile(): RegExp {
    if (this.#pattern !== undefined) return this.#pattern;
    const alternatives = [...this.#entries.values()]
      .sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value))
      .map((entry) => {
        const body = escapeRegExp(entry.value);
        if (NUMBER.test(entry.value)) {
          // A number only where it stands on its own: not inside a word or a hash, a longer
          // number, a date, a time, a version or an address.
          return `(?<![0-9A-Za-z_])(?<![0-9][.:-])${body}(?![0-9A-Za-z_])(?![.:-][0-9])`;
        }
        if (entry.value.length >= TOKEN_ONLY_BELOW) return body;
        return `(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`;
      });
    this.#pattern = new RegExp(alternatives.join("|"), "gi");
    return this.#pattern;
  }
}
