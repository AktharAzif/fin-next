// Turns a contract and its input into the URL and body `api()` sends (spec 06 §2.4). Path
// parameters are filled from the input, one encoded segment each; on a GET the other fields become
// the query string; on any other method they become the JSON body. A body-less request carries no
// body and no content type, as the origin gate expects (spec 01 §4.4, check 4).
import { type AppContract, pathParams } from "@fin/app-contracts";

export interface BuiltRequest {
  /** The path and query under the API base: `/team/members/mem_1/remove`. */
  path: string;
  /** The JSON text, or undefined for a body-less request. */
  body: string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Whether a path parameter's value is, or decodes to, a "." or ".." segment. The URL parser reads
 * `%2e` as a dot, and a server or proxy may decode a segment again before resolving it; a dot
 * segment is resolved away, so the request would reach another route under /api. Each pass only
 * shortens the value, so the loop ends.
 */
function isDotSegment(value: string): boolean {
  let current = value;
  for (;;) {
    const next = current.replace(/%25/gi, "%").replace(/%2e/gi, ".");
    if (next === current) break;
    current = next;
  }
  return current === "." || current === "..";
}

function scalar(contract: string, field: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new TypeError(`${contract}: ${field} must be a string, a finite number or a boolean`);
}

/**
 * One path parameter as one path segment. encodeURIComponent escapes `/`, `\`, `?`, `#` and `%`,
 * so the value cannot add a segment or a query; it leaves `.` alone, and the URL parser resolves a
 * `.` or `..` segment, which would send the request to another route. Those (and their
 * percent-encoded spellings, see isDotSegment), and an empty value, are refused (a programming
 * error in the screen, or a crafted link; never sent). The error names the parameter, never the
 * value.
 */
function pathSegment(contract: string, param: string, value: unknown): string {
  const raw = scalar(contract, param, value);
  if (raw === "") throw new TypeError(`${contract}: :${param} is empty`);
  if (isDotSegment(raw)) {
    throw new TypeError(`${contract}: :${param} may not be a dot segment`);
  }
  return encodeURIComponent(raw);
}

/**
 * Validates the input against the contract and builds the request. An input the contract refuses
 * is a programming error in the screen, so this throws (with the field paths only, never values).
 */
export function buildRequest(contract: AppContract, input: unknown): BuiltRequest {
  const parsed = contract.input.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "(input)");
    throw new TypeError(
      `${contract.name}: the input does not match the contract (${fields.join(", ")})`,
    );
  }
  const value: unknown = parsed.data;
  const params = pathParams(contract.path);
  let path: string = contract.path;
  let rest: Record<string, unknown> | undefined;

  if (isPlainObject(value)) {
    const fields: Record<string, unknown> = { ...value };
    // Segment by segment, so a filled value is never searched for another `:param`.
    path = contract.path
      .split("/")
      .map((segment) => {
        const param = segment.slice(1);
        return segment.startsWith(":") && params.includes(param)
          ? pathSegment(contract.name, param, fields[param])
          : segment;
      })
      .join("/");
    for (const param of params) delete fields[param];
    rest = fields;
  } else if (params.length > 0) {
    throw new TypeError(`${contract.name}: a path with parameters needs an object input`);
  }

  if (contract.method === "GET") {
    if (rest === undefined) {
      if (value !== undefined && value !== null) {
        throw new TypeError(`${contract.name}: a GET takes an object input`);
      }
      return { path, body: undefined };
    }
    const query = new URLSearchParams();
    for (const [key, field] of Object.entries(rest)) {
      if (field === undefined || field === null) continue;
      if (Array.isArray(field)) {
        for (const item of field) query.append(key, scalar(contract.name, key, item));
      } else {
        query.append(key, scalar(contract.name, key, field));
      }
    }
    const search = query.toString();
    return { path: search === "" ? path : `${path}?${search}`, body: undefined };
  }

  if (rest !== undefined) {
    return { path, body: Object.keys(rest).length === 0 ? undefined : JSON.stringify(rest) };
  }
  return { path, body: value === undefined || value === null ? undefined : JSON.stringify(value) };
}

/**
 * Seconds to wait from a `Retry-After` header: an integer of seconds, or an HTTP date. Null when
 * absent or unreadable.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}
