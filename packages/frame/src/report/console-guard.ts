// The scrubbing console guard (spec 06 §2.3 step 1; FW-C15's browser twin): in place before any
// library runs, so nothing the page prints holds an Error whole or a value a person typed. The
// guard builds what a console call would print, as one line, and scrubs that line:
//   - each value is reduced first. An Error prints as its name and a bounded code, as safeError
//     keeps them (spec 08 §5.4), with its message only when it is Fin's own words (the frame's
//     ApiError names a contract, a kind, a status and a code, never a value), and never its stack
//     or its cause. A string, number, boolean, bigint, null or undefined prints as it is, but for
//     a run of nine digits or more that the line's digits row could not see (beside a bigint's
//     `n`, or in an exponent's mantissa). Anything else (an object, an array, a DOM node) prints as
//     its kind, never its contents;
//   - a format string in the first argument (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`, `%c`, `%%`) is
//     applied here, as the console applies it (the Console Standard's Formatter), and the other
//     arguments follow, joined with spaces as the console joins them;
//   - a line longer than LINE_LIMIT is cut at a space before the limit (the run of characters the
//     limit falls in goes whole) and ends with CUT_MARK, so one huge print costs the page bounded
//     work and no part of a value is left at the cut;
//   - the whole line is then scrubbed of every shape of spec 08 §5.4 (scrub.ts), so a shape split
//     across arguments, or across a format string and its values, is found as it would be printed;
//   - the browser gets that one string, alone, or as the argument of a lone `%s` when it holds a
//     `%`: never a format it could fill again.
// A counter's or a timer's label is scrubbed, with any `%` shown as a full-width percent sign so a
// timer's data can never fill it; `dir` and `table` print their first argument only, reduced.
// Failures are reported through reportBrowserError (spec 06 §2.6), never through the console.
import { ApiError } from "../api/errors.ts";
import { scrubText } from "./scrub.ts";

/** The methods that print their arguments as a line (the Console Standard's Logger). */
const LINE_METHODS = [
  "debug",
  "dirxml",
  "error",
  "exception",
  "group",
  "groupCollapsed",
  "info",
  "log",
  "trace",
  "warn",
] as const;

/** The methods that print one value: `dir`'s options and `table`'s columns are not printed. */
const VALUE_METHODS = ["dir", "table"] as const;

/** The methods whose one argument is a counter's or a timer's label, which they print. */
const LABEL_METHODS = [
  "count",
  "countReset",
  "profile",
  "profileEnd",
  "time",
  "timeEnd",
  "timeStamp",
] as const;

const NAME = /^[A-Za-z_$][\w$]{0,63}$/;
const CODE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

/**
 * The longest line the guard scrubs and prints, in UTF-16 code units. Every scrub shape is linear,
 * but a library can print a line of any length, and the guard runs on the page's main thread.
 */
export const LINE_LIMIT = 16 * 1024;

/** What a cut line ends with. */
export const CUT_MARK = "[truncated]";

const SPACE = /\s/u;

/**
 * `line`, cut to LINE_LIMIT when it is longer. The cut takes the whole run of non-space characters
 * it falls in, so no part of a value (the start of an address, a token's first half) is left at
 * the end for a shape to miss, and the line says it was cut.
 */
function bounded(line: string): string {
  if (line.length <= LINE_LIMIT) return line;
  let end = LINE_LIMIT;
  if (!SPACE.test(line.charAt(end))) {
    while (end > 0 && !SPACE.test(line.charAt(end - 1))) end -= 1;
  }
  const kept = line.slice(0, end).trimEnd();
  return kept === "" ? CUT_MARK : `${kept} ${CUT_MARK}`;
}

/** `text` as the guard prints it: bounded, then scrubbed of every shape. */
function scrubbed(text: string): string {
  return scrubText(bounded(text));
}

/** Nine digits or more in a row: what spec 08 §5.4's digits row removes. */
const LONG_DIGITS = /\d{9,}/u;

/**
 * A number as the console prints it (a bigint with its `n`), with a run of nine digits or more
 * removed where the line's digits row cannot see it: beside a bigint's `n`, or in the mantissa of
 * the exponent form (1e21 and more, or under 1e-6), which keeps up to 17 digits beside its `e`.
 * Any other run is left to that row, which finds it with a boundary on each side.
 */
function numberText(value: number | bigint): string {
  const text = String(value);
  if (typeof value === "bigint") return `${text.replace(LONG_DIGITS, "[digits]")}n`;
  const exponent = text.indexOf("e");
  if (exponent === -1) return text;
  const digits = text.slice(0, exponent).replace(/[^0-9]/gu, "").length;
  return digits >= 9 ? "[digits]" : text;
}

function isError(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

function errorText(error: Error): string {
  const name = typeof error.name === "string" && NAME.test(error.name) ? error.name : "Error";
  if (error instanceof ApiError) return `${name}: ${scrubbed(error.message)}`;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && CODE.test(code) ? `${name} [${code}]` : name;
}

/** One console argument as the guard lets it through, alone. */
export function safeConsoleValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return scrubbed(value);
    case "number":
    case "bigint":
      // As it is, unless it prints nine digits or more in a row: then as the guard prints it.
      return LONG_DIGITS.test(String(value)) ? scrubText(numberText(value)) : value;
    case "boolean":
      return value;
    case "symbol":
      return "[symbol]";
    case "function":
      return "[function]";
    default:
      break;
  }
  const object = value as object;
  if (isError(object)) return errorText(object);
  const kind = Object.prototype.toString.call(object).slice(8, -1);
  return `[${NAME.test(kind) ? kind : "object"}]`;
}

/**
 * A value as the console prints it once reduced, before the line it is part of is scrubbed. No
 * method of the value is called: an object is only ever its kind.
 */
function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return numberText(value);
  return String(safeConsoleValue(value));
}

/** `%d` and `%i`: an integer, as the console's parseInt reads the value; NaN for anything else. */
function integerText(value: unknown): string {
  if (typeof value === "bigint") return numberText(value);
  if (typeof value === "number") {
    return numberText(Number.isFinite(value) ? Math.trunc(value) : value);
  }
  if (typeof value === "string") return numberText(Number.parseInt(value, 10));
  return "NaN";
}

/** `%f`: a number, as the console's parseFloat reads the value; NaN for anything else. */
function floatText(value: unknown): string {
  if (typeof value === "bigint" || typeof value === "number") return numberText(value);
  if (typeof value === "string") return numberText(Number.parseFloat(value));
  return "NaN";
}

function directiveText(directive: string, value: unknown): string {
  switch (directive) {
    case "d":
    case "i":
      return integerText(value);
    case "f":
      return floatText(value);
    case "c":
      // A style: nothing is printed for it.
      return "";
    default:
      // `%s`, `%o` and `%O`: the value as the guard reduces it.
      return valueText(value);
  }
}

/**
 * `format` with its directives filled from `args`, left to right, as the console fills them: a
 * directive with no argument left stays as it is, and the text a value brings is never read as a
 * format again. Returns the text and how many arguments it used.
 */
function applyFormat(format: string, args: readonly unknown[]): { text: string; used: number } {
  let text = "";
  let used = 0;
  let index = 0;
  while (index < format.length) {
    const percent = format.indexOf("%", index);
    if (percent === -1 || percent === format.length - 1) {
      text += format.slice(index);
      break;
    }
    text += format.slice(index, percent);
    const directive = format.charAt(percent + 1);
    index = percent + 2;
    if (directive === "%") text += "%";
    else if ("sdifoOc".includes(directive) && used < args.length) {
      text += directiveText(directive, args[used]);
      used += 1;
    } else text += `%${directive}`;
  }
  return { text, used };
}

/** Values as the console prints them side by side: each reduced, joined with spaces. */
function joinedLine(data: readonly unknown[]): string {
  return data.map(valueText).join(" ");
}

/**
 * What the console prints for these arguments, as one line before it is scrubbed: a string first
 * argument followed by others is a format (the Console Standard's Logger), and every argument it
 * does not use follows, joined.
 */
function consoleLine(data: readonly unknown[]): string {
  const [first, ...rest] = data;
  if (typeof first !== "string" || rest.length === 0) return joinedLine(data);
  const { text, used } = applyFormat(first, rest);
  return used === rest.length ? text : `${text} ${joinedLine(rest.slice(used))}`;
}

/**
 * The arguments that print `line` exactly as it is: the line alone when it holds no `%`, else as
 * the argument of a lone `%s`, whose text no console reads as a format again.
 */
function printing(line: string): unknown[] {
  return line.includes("%") ? ["%s", line] : [line];
}

/** The arguments a printing call gets: its line, built, bounded and scrubbed whole; none for none. */
function guardedArguments(data: readonly unknown[]): unknown[] {
  return data.length === 0 ? [] : printing(scrubbed(consoleLine(data)));
}

/** U+FF05, which a label shows in place of `%`. */
const FULL_WIDTH_PERCENT = String.fromCharCode(0xff05);

/**
 * A counter's or a timer's label as the console gets it: reduced and scrubbed, the same for every
 * call that names it, so `time` and `timeEnd` still meet. A `%` in it is shown as a full-width
 * percent sign: a timer's data can then never fill it as a directive.
 */
function labelText(label: unknown): string | undefined {
  return label === undefined
    ? undefined
    : scrubbed(valueText(label)).replaceAll("%", FULL_WIDTH_PERCENT);
}

type ConsoleMethod = (...data: unknown[]) => unknown;

const guarded = new WeakSet<object>();

/**
 * Wraps the console's printing methods so what each call prints is built and scrubbed here.
 * Installed once per console (later calls do nothing); returns the remover, for tests. A console
 * context (Chromium's `console.context()`) is guarded as it is made.
 */
export function installConsoleGuard(target: Console = globalThis.console): () => void {
  if (guarded.has(target)) return () => {};
  guarded.add(target);
  const methods = target as unknown as Record<string, ConsoleMethod | undefined>;
  const originals = new Map<string, ConsoleMethod>();
  const wrap = (method: string, guard: (original: ConsoleMethod) => ConsoleMethod) => {
    const original = methods[method];
    if (typeof original !== "function") return;
    originals.set(method, original);
    methods[method] = guard(original);
  };

  for (const method of LINE_METHODS) {
    wrap(
      method,
      (original) =>
        (...data) =>
          original.apply(target, guardedArguments(data)),
    );
  }
  for (const method of VALUE_METHODS) {
    wrap(
      method,
      (original) =>
        (...data) =>
          original.apply(target, data.length === 0 ? [] : [scrubbed(valueText(data[0]))]),
    );
  }
  for (const method of LABEL_METHODS) {
    wrap(method, (original) => (label?: unknown) => original.call(target, labelText(label)));
  }
  // A timer's data follow its label and duration, printed side by side (never as a format).
  wrap(
    "timeLog",
    (original) =>
      (label?: unknown, ...data: unknown[]) =>
        original.call(
          target,
          labelText(label),
          ...(data.length === 0 ? [] : [scrubbed(joinedLine(data))]),
        ),
  );
  // The first argument is the condition, which decides whether anything prints at all.
  wrap(
    "assert",
    (original) =>
      (condition?: unknown, ...data: unknown[]) =>
        condition
          ? original.call(target, condition)
          : original.call(target, condition, ...guardedArguments(data)),
  );
  wrap("context", (original) => (...data) => {
    const context: unknown = original.apply(target, data);
    if (typeof context === "object" && context !== null) installConsoleGuard(context as Console);
    return context;
  });

  return () => {
    for (const [method, original] of originals) methods[method] = original;
    guarded.delete(target);
  };
}
