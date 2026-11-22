// The personal-data shapes recordAudit refuses in metadata (spec 08 §3.3, T08-07): an email address, an
// IP address, a token or key shape, a URL with a query, or a run of nine or more digits. The patterns
// are spec 08 §5.4's for those shapes. packages/core's `assertNoPersonalShapes` (P0-D) will hold the
// shared list; this module is replaced by it when that lands (recorded in the pull request).

const SHAPES: readonly { name: string; pattern: RegExp }[] = [
  { name: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/u },
  { name: "ipv4", pattern: /\b(?:\d{1,3}\.){3}\d{1,3}\b/u },
  {
    name: "ipv6",
    pattern: /\b(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{0,4}\b|::(?:[0-9a-fA-F]{1,4}:?){1,7}/u,
  },
  { name: "api-key", pattern: /fin_(?:test|live)_(?:sk|rk)_[0-9A-Za-z]{10,}/u },
  { name: "webhook-secret", pattern: /whsec_[A-Za-z0-9+/=_-]{8,}/u },
  { name: "bearer", pattern: /bearer\s+[A-Za-z0-9._~+/=-]{8,}/iu },
  { name: "jwt", pattern: /eyJ[A-Za-z0-9_-]{8,}/u },
  { name: "cloudflare-token", pattern: /cfat_[A-Za-z0-9_-]{8,}/u },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: "age-identity", pattern: /AGE-SECRET-KEY-1/u },
  { name: "postgres-url", pattern: /postgres(?:ql)?:\/\/[^:/\s]+:[^@\s]+@/u },
  { name: "url-query", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s?#]*\?/iu },
  { name: "digits", pattern: /\b\d{9,}\b/u },
];

export class AuditMetadataError extends Error {
  override readonly name = "AuditMetadataError";
  /** The field and the shape found, never the value. */
  readonly field: string;
  readonly shape: string;
  constructor(field: string, shape: string) {
    super(`audit metadata ${field} holds a ${shape} shape`);
    this.field = field;
    this.shape = shape;
  }
}

/** The first personal or secret shape in a string, or undefined. */
export function personalShapeOf(text: string): string | undefined {
  return SHAPES.find((shape) => shape.pattern.test(text))?.name;
}

/** Calls `visit` with every string in the value, at any depth, and the path that names it. */
function eachString(
  value: unknown,
  field: string,
  visit: (text: string, field: string) => void,
): void {
  if (typeof value === "string") {
    visit(value, field);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      eachString(item, `${field}[${i}]`, visit);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value)) eachString(item, `${field}.${key}`, visit);
  }
}

/** Throws AuditMetadataError when any string in the value (at any depth) holds a refused shape. */
export function assertNoPersonalShapes(value: unknown, field = "metadata"): void {
  eachString(value, field, (text, path) => {
    const shape = personalShapeOf(text);
    if (shape !== undefined) throw new AuditMetadataError(path, shape);
  });
}

/**
 * The reason Postgres could not store a string as JSON text, or undefined when it can. JSON.stringify
 * writes a lone surrogate as `\udXXX`, which jsonb refuses (22P02), and U+0000 as `\u0000`, which jsonb
 * refuses too (22P05): no Postgres text value holds a NUL. Every other character, control characters
 * included, is stored as it is.
 */
export function unstorableShapeOf(text: string): "lone-surrogate" | "nul" | undefined {
  if (!text.isWellFormed()) return "lone-surrogate";
  if (text.includes("\u0000")) return "nul";
  return undefined;
}

/**
 * Throws AuditMetadataError (shape `lone-surrogate` or `nul`) when any string in the value is one
 * Postgres could not store (unstorableShapeOf), so the row could not be written and the action would
 * fail with a code no audit alert reads.
 */
export function assertStorableText(value: unknown, field: string): void {
  eachString(value, field, (text, path) => {
    const shape = unstorableShapeOf(text);
    if (shape !== undefined) throw new AuditMetadataError(path, shape);
  });
}
