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

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return scrubText(value);
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[cycle]";
  if (depth >= MAX_DEPTH) return "[depth]";
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => scrubValue(item, depth + 1, seen));
    seen.delete(value);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = isWithheldField(key) ? WITHHELD : scrubValue(item, depth + 1, seen);
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
    } else {
      out[key] = isWithheldField(key) ? WITHHELD : scrubValue(item, 1, new WeakSet());
    }
  }
  return out;
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubFrames(frames: unknown): unknown[] {
  if (!Array.isArray(frames)) return [];
  return frames.filter(isRecord).map((frame) => {
    const out: Json = {};
    for (const key of ["filename", "function", "module", "lineno", "colno", "in_app"]) {
      const item = frame[key];
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
        if (typeof value.type === "string") item.type = scrubText(value.type).slice(0, 120);
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
 * Throws when any string in `value`, at any depth, holds a known shape, or when a withheld field
 * carries a value. `recordAudit` calls it on an event's metadata (spec 08 §5.3).
 */
export function assertNoPersonalShapes(value: unknown): void {
  const visit = (item: unknown, depth: number): void => {
    if (typeof item === "string") {
      if (hasPersonalShape(item)) {
        throw new FinError("personal_shape", "A value holds a personal or secret shape");
      }
      return;
    }
    if (typeof item !== "object" || item === null) return;
    if (depth >= MAX_DEPTH) {
      throw new FinError("personal_shape", "A value is nested too deeply to check");
    }
    if (Array.isArray(item)) {
      for (const element of item) visit(element, depth + 1);
      return;
    }
    for (const [key, element] of Object.entries(item)) {
      if (isWithheldField(key) && element !== null && element !== undefined) {
        throw new FinError("personal_shape", "A withheld field carries a value");
      }
      visit(element, depth + 1);
    }
  };
  visit(value, 0);
}
