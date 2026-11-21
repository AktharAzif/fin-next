// Turns a contract and its input into the URL and body `api()` sends (spec 06 §2.4). Path
// parameters are filled from the input and encoded; on a GET the other fields become the query
// string; on any other method they become the JSON body. A body-less request carries no body and
// no content type, as the origin gate expects (spec 01 §4.4, check 4).
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

function scalar(contract: string, field: string, value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  throw new TypeError(`${contract}: ${field} must be a string, a finite number or a boolean`);
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
    rest = { ...value };
    for (const param of params) {
      const raw = scalar(contract.name, param, rest[param]);
      if (raw === "") throw new TypeError(`${contract.name}: :${param} is empty`);
      path = path.replace(`:${param}`, encodeURIComponent(raw));
      delete rest[param];
    }
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
