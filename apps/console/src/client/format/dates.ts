// Dates as the boards write them, in UTC (the tables' "Time (UTC)"): "2 Nov 2026", "20 Nov, 14:05",
// "20 Nov 2026, 14:05 UTC". A value that is not a date reads as an em dash, never "Invalid Date".

const DAY = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const SHORT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});
const TIME = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

function parse(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2 Nov 2026". */
export function formatDay(value: string | null | undefined): string {
  const date = parse(value);
  return date === null ? "—" : DAY.format(date);
}

/** "20 Nov, 14:05" (UTC). */
export function formatShort(value: string | null | undefined): string {
  const date = parse(value);
  return date === null ? "—" : SHORT.format(date).replace(/ at /, ", ");
}

/** "20 Nov 2026, 14:05 UTC". */
export function formatFull(value: string | null | undefined): string {
  const date = parse(value);
  return date === null ? "—" : `${DAY.format(date)}, ${TIME.format(date)} UTC`;
}

/** The day a row belongs to, for the audit log's day headings: "20 Nov 2026". */
export function dayKey(value: string): string {
  return formatDay(value);
}
