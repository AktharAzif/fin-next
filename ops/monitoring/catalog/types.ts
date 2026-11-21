// The catalogue entry (spec 08 §7.2). One fragment per area, `ops/monitoring/catalog/<area>.ts`,
// owned by the area's lane; each exports `entries`. monitoring:check reads every fragment.

export type CatalogKind = "unit" | "failure" | "security" | "money" | "info";
export type CatalogLevel = "info" | "warn" | "error";
export type CatalogFieldType = "string" | "number" | "boolean" | "string[]" | "number[]" | "object";

export interface CatalogEntry {
  /** The event name exactly as code writes it. */
  readonly event: string;
  /** An event may be a unit line and a failure at once (spec 01 §8.9); the first kind leads. */
  readonly kind: CatalogKind | readonly CatalogKind[];
  readonly level: CatalogLevel;
  /** Fields beyond the envelope (ARCHITECTURE §10.2). */
  readonly fields: Readonly<Record<string, CatalogFieldType>>;
  /** ReasonCode values this area adds. */
  readonly reasons?: readonly string[];
  /** Alert names in ops/monitoring/<env>/alerts/*.json that watch this event. */
  readonly alerts: readonly string[];
  /** Required when `alerts` is empty and a kind is failure, security or money. */
  readonly noAlert?: string;
  /** Who writes it, for the reader. */
  readonly writtenBy: string;
}

/** The envelope's fields, on every line (spec 08 §7.2). Never declared again by an entry. */
export const ENVELOPE_FIELDS: readonly string[] = [
  "dt",
  "message",
  "event",
  "level",
  "service",
  "environment",
  "release",
  "replica",
  "requestId",
  "runId",
  "truncated",
];

export function kindsOf(entry: CatalogEntry): readonly CatalogKind[] {
  return typeof entry.kind === "string" ? [entry.kind] : entry.kind;
}
