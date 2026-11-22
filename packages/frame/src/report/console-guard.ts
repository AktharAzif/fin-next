// The scrubbing console guard (spec 06 §2.3 step 1; FW-C15's browser twin): in place before any
// library runs, so nothing the page prints holds an Error whole or a value a person typed. Every
// argument of a console call is reduced before the browser's console sees it:
//   - an Error: its name and a bounded code, as safeError keeps them (spec 08 §5.4); its message
//     only when it is Fin's own words (the frame's ApiError names a contract, a kind, a status and
//     a code, never a value); never its stack or its cause;
//   - a string: scrubbed of the shapes addresses, tokens, keys, cookies and query strings take;
//   - a number, boolean, bigint, null or undefined: as it is;
//   - anything else (an object, an array, a DOM node): its kind, never its contents.
// Failures are reported through reportBrowserError (spec 06 §2.6), never through the console.
import { ApiError } from "../api/errors.ts";
import { scrubText } from "./scrub.ts";

const METHODS = [
  "debug",
  "dir",
  "dirxml",
  "error",
  "group",
  "groupCollapsed",
  "info",
  "log",
  "table",
  "trace",
  "warn",
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

/** One console argument as the guard lets it through. */
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

type ConsoleMethod = (...data: unknown[]) => void;

const guarded = new WeakSet<object>();

/**
 * Wraps the console's printing methods so each argument goes through safeConsoleValue. Installed
 * once per console (later calls do nothing); returns the remover, for tests.
 */
export function installConsoleGuard(target: Console = globalThis.console): () => void {
  if (guarded.has(target)) return () => {};
  guarded.add(target);
  const methods = target as unknown as Record<string, ConsoleMethod | undefined>;
  const originals = new Map<string, ConsoleMethod>();
  for (const method of METHODS) {
    const original = methods[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    methods[method] = (...data: unknown[]) => original.apply(target, data.map(safeConsoleValue));
  }
  const assert = methods.assert;
  if (typeof assert === "function") {
    originals.set("assert", assert);
    // The first argument is the condition, which decides whether anything prints at all.
    methods.assert = (condition?: unknown, ...data: unknown[]) =>
      assert.call(target, condition, ...data.map(safeConsoleValue));
  }
  return () => {
    for (const [method, original] of originals) methods[method] = original;
    guarded.delete(target);
  };
}
