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

/** Throws AuditMetadataError when any string in the value (at any depth) holds a refused shape. */
export function assertNoPersonalShapes(value: unknown, field = "metadata"): void {
  if (typeof value === "string") {
    const shape = personalShapeOf(value);
    if (shape !== undefined) throw new AuditMetadataError(field, shape);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertNoPersonalShapes(item, `${field}[${i}]`);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, item] of Object.entries(value))
      assertNoPersonalShapes(item, `${field}.${key}`);
  }
}
