// The scrubbing console guard (spec 06 §2.3 step 1; FW-C15's browser twin): in place before any
// library runs, so nothing the page prints holds an Error whole or a value a person typed. The
// guard builds what a console call would print, as one line, and scrubs that line:
//   - each value is reduced first. An Error prints as its name and a bounded code, as safeError
//     keeps them (spec 08 §5.4), with its message only when it is Fin's own words (the frame's
//     ApiError names a contract, a kind, a status and a code, never a value), and never its stack
//     or its cause. A string, number, boolean, bigint, null or undefined prints as it is. Anything
//     else (an object, an array, a DOM node) prints as its kind, never its contents;
//   - a format string in the first argument (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`, `%c`, `%%`) is
//     applied here, as the console applies it (the Console Standard's Formatter), and the other
//     arguments follow, joined with spaces as the console joins them;
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

function isError(value: object): value is Error {
  return value instanceof Error || Object.prototype.toString.call(value) === "[object Error]";
}

function errorText(error: Error): string {
  const name = typeof error.name === "string" && NAME.test(error.name) ? error.name : "Error";
  if (error instanceof ApiError) return `${name}: ${scrubText(error.message)}`;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && CODE.test(code) ? `${name} [${code}]` : name;
}

/** One console argument as the guard lets it through, alone. */
export function safeConsoleValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case "string":
      return scrubText(value);
    case "number":
    case "boolean":
    case "bigint":
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
  if (typeof value === "bigint") return `${value}n`;
  return String(safeConsoleValue(value));
}

/** `%d` and `%i`: an integer, as the console's parseInt reads the value; NaN for anything else. */
function integerText(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return String(Number.isFinite(value) ? Math.trunc(value) : value);
  if (typeof value === "string") return String(Number.parseInt(value, 10));
  return "NaN";
}

/** `%f`: a number, as the console's parseFloat reads the value; NaN for anything else. */
function floatText(value: unknown): string {
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return String(Number.parseFloat(value));
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

/** The arguments a printing call gets: its line, built and scrubbed whole; none for none. */
function guardedArguments(data: readonly unknown[]): unknown[] {
  return data.length === 0 ? [] : printing(scrubText(consoleLine(data)));
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
    : scrubText(valueText(label)).replaceAll("%", FULL_WIDTH_PERCENT);
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
          original.apply(target, data.length === 0 ? [] : [scrubText(valueText(data[0]))]),
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
          ...(data.length === 0 ? [] : [scrubText(joinedLine(data))]),
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
