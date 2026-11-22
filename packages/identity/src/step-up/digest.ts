// The intent digest (spec 02 §7.2, T-SAT-07): SHA-256 over the RFC 8785 canonical JSON of
// `{ realm, action, org, target, params }`. `params` holds only the fields the action binds,
// strings in Unicode NFC, addresses lower-cased, arrays of keys sorted. The canonical form here
// covers plain objects, strings, booleans, integers, null and arrays; a float, a non-plain object
// or an unsafe integer is refused, so two encoders can never disagree.
import { createHash } from "node:crypto";

export type CanonicalValue =
  | string
  | boolean
  | number
  | null
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue };

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** RFC 8785's string form: JSON.stringify's escapes are exactly ECMAScript's, which 8785 uses. */
function canonicalString(value: string): string {
  return JSON.stringify(value);
}

/** RFC 8785 orders object keys by their UTF-16 code units, which is JavaScript's default sort. */
function compareUtf16(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return canonicalString(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new CanonicalJsonError("only safe integers are allowed in a digest");
      }
      return Object.is(value, -0) ? "0" : String(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError("only plain objects are allowed in a digest");
      }
      const entries = Object.entries(value as Record<string, unknown>).filter(
        ([, v]) => v !== undefined,
      );
      entries.sort(([a], [b]) => compareUtf16(a, b));
      return `{${entries.map(([k, v]) => `${canonicalString(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`a ${typeof value} cannot be part of a digest`);
  }
}

/** How a bound field is normalised before it is digested. */
export type BindKind = "string" | "address" | "keys" | "value";

export interface BindField {
  readonly name: string;
  readonly kind: BindKind;
}

function normaliseBound(kind: BindKind, value: unknown): CanonicalValue {
  if (value === undefined) return null;
  switch (kind) {
    case "string":
      if (typeof value !== "string") throw new CanonicalJsonError("a bound string is not a string");
      return value.normalize("NFC");
    case "address":
      if (typeof value !== "string")
        throw new CanonicalJsonError("a bound address is not a string");
      return value.normalize("NFC").trim().toLowerCase();
    case "keys": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
        throw new CanonicalJsonError("a bound key list is not a list of strings");
      }
      const keys = (value as string[]).map((v) => v.normalize("NFC"));
      return [...new Set(keys)].sort(compareUtf16);
    }
    case "value":
      return normaliseValue(value);
  }
}

function normaliseValue(value: unknown): CanonicalValue {
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) return value.map(normaliseValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k.normalize("NFC"),
        normaliseValue(v),
      ]),
    );
  }
  return value as CanonicalValue;
}

export interface DigestInput {
  realm: "developer" | "staff";
  action: string;
  org: string | null;
  target: string | null;
  /** The request's fields; only those named in `bind` are digested. */
  body: Readonly<Record<string, unknown>>;
  bind: readonly BindField[];
}

/** The canonical document an intent's digest covers. Secrets are never bound (§7.2). */
export function digestDocument(input: DigestInput): string {
  const params: Record<string, CanonicalValue> = {};
  for (const field of input.bind)
    params[field.name] = normaliseBound(field.kind, input.body[field.name]);
  return canonicalJson({
    realm: input.realm,
    action: input.action,
    org: input.org,
    target: input.target,
    params,
  });
}

export function paramsDigest(input: DigestInput): Buffer {
  return createHash("sha256").update(digestDocument(input), "utf8").digest();
}
