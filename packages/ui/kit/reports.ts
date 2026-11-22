// What the kit keeps of each failure report, so the kit spec can read what a report carried, not
// only that there was one: the error's name and message, its cause and any field of its own, and
// the IDs. Those are what a reporter could send of it (a relay sends an error's cause and its own
// fields as well as its message), so a value that reached any of them shows in the kept report, and
// in the page the spec reads.
import type { FailureReporter } from "../src/index.ts";

export interface KitReport {
  readonly name: string;
  readonly message: string;
  /** The error's cause, as text, or null when it has none. */
  readonly cause: string | null;
  /** The error's own enumerable fields beside its name and message, as text. */
  readonly fields: Readonly<Record<string, string>>;
  readonly ids: Readonly<Record<string, string>>;
}

/** A value as text: an error as its name and message, anything else as JSON where it can be. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** What one report carried, as the kit keeps it. */
export function keepReport(error: unknown, ids: Readonly<Record<string, string>>): KitReport {
  const kept = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, asText(id)]));
  if (!(error instanceof Error)) {
    return { name: typeof error, message: asText(error), cause: null, fields: {}, ids: kept };
  }
  const fields = Object.fromEntries(
    Object.entries(error)
      .filter(([key]) => key !== "name" && key !== "message")
      .map(([key, field]) => [key, asText(field)]),
  );
  return {
    name: error.name,
    message: error.message,
    cause: error.cause === undefined ? null : asText(error.cause),
    fields,
    ids: kept,
  };
}

/**
 * The kit page's reporter: marks the body (`data-reported`) and keeps every report in order, as
 * JSON in the body's `data-report-log`.
 */
export function bodyReporter(): FailureReporter {
  const kept: KitReport[] = [];
  return (error, ids) => {
    kept.push(keepReport(error, ids));
    document.body.setAttribute("data-reported", "");
    document.body.setAttribute("data-report-log", JSON.stringify(kept));
  };
}
