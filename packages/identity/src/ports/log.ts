// Structured lines (ARCHITECTURE §10.2, spec 08 §7.2, spec 02 §18.1). This package writes its
// event lines through a LineSink the process gives it; packages/core's scrubber and Better
// Stack shipping sit behind that sink (P0-D). Every field here is an ID, a code, a count or a
// bounded enum: never an address, a name, a user agent, a code, a token or a query string.

export type LineLevel = "info" | "warn" | "error";
export type LineValue = string | number | boolean | null | readonly string[];
export type LineFields = Readonly<Record<string, LineValue | undefined>>;

export interface LineSink {
  write(event: string, level: LineLevel, fields: LineFields): void;
}

/** A sink that keeps lines in memory, for tests. */
export class MemoryLineSink implements LineSink {
  readonly lines: { event: string; level: LineLevel; fields: LineFields }[] = [];
  write(event: string, level: LineLevel, fields: LineFields): void {
    this.lines.push({ event, level, fields: { ...fields } });
  }
  named(event: string): LineFields[] {
    return this.lines.filter((l) => l.event === event).map((l) => l.fields);
  }
  clear(): void {
    this.lines.length = 0;
  }
}

/** Throws away every line (for code paths that have no sink in a unit test). */
export const nullLineSink: LineSink = { write: () => undefined };

const SAFE_STRING = /^[A-Za-z0-9_.:/*-]{0,120}$/;

/**
 * Refuses a value that is not one of the shapes a line may carry, so a caller cannot put an
 * address or free text into a line by mistake. Strings are IDs, codes, route templates or enum
 * values; anything else is dropped and replaced by a marker.
 */
export function safeLineFields(fields: LineFields): LineFields {
  const out: Record<string, LineValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (typeof value === "string") {
      out[key] = SAFE_STRING.test(value) ? value : "[refused]";
    } else if (Array.isArray(value)) {
      out[key] = value.map((v) => (SAFE_STRING.test(v) ? v : "[refused]"));
    } else {
      out[key] = value as LineValue;
    }
  }
  return out;
}
