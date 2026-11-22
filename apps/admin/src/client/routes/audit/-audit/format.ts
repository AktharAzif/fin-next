// AdminAudit's times, in UTC as Fin Admin shows them, with seconds: the column's "19 Nov 2026,
// 16:20:31" (its header says UTC), the drawer's "19 November 2026, 16:20:31 UTC", and a custom
// range's days ("1 Nov 2026"). Formatters are made on first use, never at module scope.

let short: Intl.DateTimeFormat | undefined;
let long: Intl.DateTimeFormat | undefined;
let day: Intl.DateTimeFormat | undefined;

function parts(format: Intl.DateTimeFormat, ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
  return out;
}

function at(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function make(month: "short" | "long", time: boolean): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month,
    year: "numeric",
    ...(time ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" } : {}),
  });
}

/** `19 Nov 2026, 16:20:31`, or the value itself when it is not a time. */
export function formatWhen(iso: string): string {
  const ms = at(iso);
  if (ms === null) return iso;
  short ??= make("short", true);
  const p = parts(short, ms);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second}`;
}

/** `19 November 2026, 16:20:31 UTC`. */
export function formatWhenLong(iso: string): string {
  const ms = at(iso);
  if (ms === null) return iso;
  long ??= make("long", true);
  const p = parts(long, ms);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}:${p.second} UTC`;
}

/** A `YYYY-MM-DD` day as `1 Nov 2026`. */
export function formatDay(value: string): string {
  const ms = at(`${value}T00:00:00.000Z`);
  if (ms === null) return value;
  day ??= make("short", false);
  const p = parts(day, ms);
  return `${p.day} ${p.month} ${p.year}`;
}
