// The scrubbers (spec 08 §5.4; ARCHITECTURE §10.2, §10.3; AC-P0-12, AC-P0-40). Every line is
// scrubbed before stdout and before shipping; every error report before it is sent. Web APIs only,
// so the watcher and the browser run the same code.
import { FinError } from "./errors.ts";
import { SHAPES, type Shape, WITHHELD_FIELDS } from "./scrub-shapes.ts";

export const WITHHELD = "[withheld]";
const MAX_DEPTH = 8;

function applyShape(text: string, shape: Shape): string {
  shape.pattern.lastIndex = 0;
  const token = shape.token;
  return typeof token === "string"
    ? text.replace(shape.pattern, token)
    : text.replace(shape.pattern, (match: string, ...rest: unknown[]) =>
        token(match, ...rest.filter((r): r is string => typeof r === "string")),
      );
}

/** Replaces every known shape in a string with its token. */
export function scrubText(text: string): string {
  let out = text;
  for (const shape of SHAPES) out = applyShape(out, shape);
  return out;
}

function normalisedKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}

/** Whether a field's value is withheld whatever it holds. */
export function isWithheldField(key: string): boolean {
  if (/(?:Id|_id|Ids|_ids)$/.test(key)) return false;
  return WITHHELD_FIELDS.has(normalisedKey(key));
}

const ERROR_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/** The class name of a thrown value that reached a line as a field: nothing else of it is kept. */
function errorNameOf(error: Error): string {
  const name = error.constructor?.name;
  return typeof name === "string" && ERROR_NAME.test(name) ? name : "Error";
}

/**
 * What JSON.stringify would write for an object, as plain data the scrubber can walk: an own or
 * inherited `toJSON` is called here (a Date becomes its ISO string), never later where nothing
 * would scrub its result; a Map becomes an object, a Set an array; bytes and errors keep nothing.
 */
function serialisable(value: object): unknown {
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[binary]";
  if (value instanceof Error) return { errorName: errorNameOf(value) };
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) out[String(key)] = item;
    return out;
  }
  if (value instanceof Set) return [...value];
  const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") return toJSON.call(value);
  return value;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "bigint") return scrubText(value.toString());
  // JSON.stringify drops functions and symbols; so does the scrubber, before anything can call one.
  if (typeof value === "function" || typeof value === "symbol") return undefined;
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[cycle]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(value);
  let data: unknown;
  try {
    data = serialisable(value);
  } catch {
    data = "[unserialisable]";
  }
  let out: unknown;
  if (data !== value) {
    out = scrubValue(data, depth + 1, seen);
  } else if (Array.isArray(value)) {
    out = value.map((item) => scrubValue(item, depth + 1, seen));
  } else {
    const record: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const scrubbed = isWithheldField(key) ? WITHHELD : scrubValue(item, depth + 1, seen);
      // A key is text like any other: a map keyed by an address or a token loses the shape.
      if (scrubbed !== undefined) record[scrubText(key)] = scrubbed;
    }
    out = record;
  }
  seen.delete(value);
  return out;
}

/** Scrubs any value: withheld fields at any depth, then every shape in every string. */
export function scrubValueDeep(value: unknown): unknown {
  return scrubValue(value, 0, new WeakSet());
}

/**
 * Scrubs one log line. The envelope's `message` equals its `event` (Railway needs `message`), so
 * it is kept when it does; any other `message` is withheld like every other withheld field.
 */
export function scrubLine(line: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(line)) {
    if (key === "message" && typeof item === "string" && item === line.event) {
      out[key] = scrubText(item);
      continue;
    }
    const scrubbed = isWithheldField(key) ? WITHHELD : scrubValue(item, 1, new WeakSet());
    if (scrubbed !== undefined) out[scrubText(key)] = scrubbed;
  }
  return out;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A frame's file as a stack parser reports it: a path, a `node:` name or a URL, never text with
 * spaces or punctuation, which only a message line shaped like a frame would put there.
 */
export const FRAME_FILE =
  /^(?:(?:\/|node:|[a-z][a-z0-9+.-]*:\/\/)[^\s"'(),;<>[\]{}]{1,299}|<anonymous>|native)$/;

/**
 * A frame's function as V8 and Sentry's parsers write it ("handle", "Object.<anonymous>",
 * "new Foo", "Foo.bar [as baz]", "Object.?"): never words separated by spaces.
 */
export const FRAME_FUNCTION =
  /^(?:async )?(?:new )?[A-Za-z_$<?][\w$.<>?]{0,119}(?: \[as [\w$.<>]{1,60}\])?$/;

function scrubFrames(frames: unknown): unknown[] {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter(isRecord)
    .filter((frame) => typeof frame.filename !== "string" || FRAME_FILE.test(frame.filename))
    .map((frame) => {
      const out: Json = {};
      for (const key of ["filename", "function", "module", "lineno", "colno", "in_app"]) {
        const item = frame[key];
        if (key === "function" && typeof item === "string" && !FRAME_FUNCTION.test(item)) continue;
        if (key === "module" && typeof item === "string" && !/^[\w$.:/@-]{1,200}$/.test(item)) {
          continue;
        }
        if (typeof item === "string") out[key] = scrubText(item).slice(0, 300);
        else if (typeof item === "number" || typeof item === "boolean") out[key] = item;
      }
      return out;
    });
}

/** A context's `name` and `version` (a runtime's or an SDK's, never a person's). */
function nameAndVersion(source: Json): Json {
  const out: Json = {};
  for (const key of ["name", "version"]) {
    const item = source[key];
    if (typeof item === "string") out[key] = scrubText(item).slice(0, 100);
  }
  return out;
}

/**
 * Scrubs an error-reporting event (spec 08 §7.5): keeps the exception type, a message only for a
 * FinError (the `fin_fixed_message` tag), the frames and the ID tags; drops `request`, `user`,
 * `extra`, `server_name`, the device context, the OS context beyond its name and every breadcrumb
 * but a navigation one; then scrubs every remaining string. Browser-safe.
 */
export function scrubEvent<T extends object>(event: T): T {
  const source = event as Json;
  const fixedMessage = isRecord(source.tags) && source.tags.fin_fixed_message === "true";
  const out: Json = {};
  if (isRecord(source.sdk)) out.sdk = nameAndVersion(source.sdk);
  for (const key of [
    "event_id",
    "timestamp",
    "platform",
    "level",
    "release",
    "environment",
    "dist",
    "fingerprint",
    "transaction",
    "type",
    "logger",
  ]) {
    if (source[key] !== undefined) out[key] = scrubValueDeep(source[key]);
  }
  if (isRecord(source.tags)) {
    const tags: Json = {};
    for (const [key, value] of Object.entries(source.tags)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        tags[key] = typeof value === "string" ? scrubText(value).slice(0, 200) : value;
      }
    }
    out.tags = tags;
  }
  const exception = source.exception;
  if (isRecord(exception) && Array.isArray(exception.values)) {
    out.exception = {
      values: exception.values.filter(isRecord).map((value) => {
        const item: Json = {};
        // The type is a class name; anything else in it is free text and is not kept.
        if (typeof value.type === "string") {
          item.type = ERROR_NAME.test(value.type) ? value.type : "Error";
        }
        item.value =
          fixedMessage && typeof value.value === "string"
            ? scrubText(value.value).slice(0, 200)
            : WITHHELD;
        if (isRecord(value.mechanism)) {
          const mechanism: Json = {};
          if (typeof value.mechanism.type === "string") mechanism.type = value.mechanism.type;
          if (typeof value.mechanism.handled === "boolean") {
            mechanism.handled = value.mechanism.handled;
          }
          item.mechanism = mechanism;
        }
        if (isRecord(value.stacktrace)) {
          item.stacktrace = { frames: scrubFrames(value.stacktrace.frames) };
        }
        return item;
      }),
    };
  }
  if (isRecord(source.contexts)) {
    const contexts: Json = {};
    const { os, runtime, app, trace } = source.contexts;
    if (isRecord(os) && typeof os.name === "string") contexts.os = { name: scrubText(os.name) };
    if (isRecord(runtime)) contexts.runtime = nameAndVersion(runtime);
    if (isRecord(app)) contexts.app = scrubValueDeep(app);
    if (isRecord(trace)) contexts.trace = scrubValueDeep(trace);
    out.contexts = contexts;
  }
  if (Array.isArray(source.breadcrumbs)) {
    out.breadcrumbs = source.breadcrumbs
      .map((crumb) => (isRecord(crumb) ? scrubBreadcrumb(crumb) : null))
      .filter((crumb) => crumb !== null);
  }
  return out as T;
}

/** Keeps a navigation breadcrumb (its route templates scrubbed) and drops every other kind. */
export function scrubBreadcrumb<T extends object>(breadcrumb: T): T | null {
  const source = breadcrumb as Json;
  if (source.category !== "navigation") return null;
  const out: Json = { category: "navigation" };
  if (typeof source.timestamp === "number") out.timestamp = source.timestamp;
  if (isRecord(source.data)) {
    const data: Json = {};
    for (const key of ["from", "to"]) {
      const item = source.data[key];
      if (typeof item === "string") data[key] = scrubText(item.replace(/[?#].*$/, ""));
    }
    out.data = data;
  }
  return out as T;
}

/** Whether a string holds any known shape. */
export function hasPersonalShape(text: string): boolean {
  return scrubText(text) !== text;
}

/**
 * Throws when any string in `value`, at any depth, holds a known shape (keys included), or when a
 * withheld field carries a value. What an object's `toJSON` returns is checked, since that is what
 * gets stored. `recordAudit` calls it on an event's metadata (spec 08 §5.3).
 */
export function assertNoPersonalShapes(value: unknown): void {
  const refuse = (message: string): never => {
    throw new FinError("personal_shape", message);
  };
  const visit = (item: unknown, depth: number): void => {
    if (typeof item === "string") {
      if (hasPersonalShape(item)) refuse("A value holds a personal or secret shape");
      return;
    }
    if (typeof item === "bigint") {
      if (hasPersonalShape(item.toString())) refuse("A value holds a personal or secret shape");
      return;
    }
    if (typeof item !== "object" || item === null) return;
    if (depth >= MAX_DEPTH) refuse("A value is nested too deeply to check");
    const toJSON: unknown = (item as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      visit(toJSON.call(item), depth + 1);
      return;
    }
    if (Array.isArray(item)) {
      for (const element of item) visit(element, depth + 1);
      return;
    }
    for (const [key, element] of Object.entries(item)) {
      if (hasPersonalShape(key)) refuse("A key holds a personal or secret shape");
      if (isWithheldField(key) && element !== null && element !== undefined) {
        refuse("A withheld field carries a value");
      }
      visit(element, depth + 1);
    }
  };
  visit(value, 0);
}
