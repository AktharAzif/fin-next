// Times as Fin Admin shows them: in UTC, said so, British order ("18 Nov 2026, 09:05 UTC").
// Formatters are made on first use, never at module scope.

let dateTime: Intl.DateTimeFormat | undefined;
let time: Intl.DateTimeFormat | undefined;

function parts(format: Intl.DateTimeFormat, iso: string): Record<string, string> | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const out: Record<string, string> = {};
  for (const part of format.formatToParts(new Date(ms))) out[part.type] = part.value;
  return out;
}

/** `18 Nov 2026, 09:05 UTC`, or null for a value that is not a time. */
export function formatUtc(iso: string): string | null {
  dateTime ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = parts(dateTime, iso);
  if (p === null) return null;
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} UTC`;
}

/** `10:30 UTC`. */
export function formatTimeUtc(iso: string): string | null {
  time ??= new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const p = parts(time, iso);
  if (p === null) return null;
  return `${p.hour}:${p.minute} UTC`;
}
