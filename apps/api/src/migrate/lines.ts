// The migrate service's lines (spec 01 §8.9; spec 08 §7.2's envelope): one JSON object per line on
// stdout, which Railway keeps and Better Stack's shipper reads. Fields are IDs, names and codes only.
// packages/server's writer (P0-D) replaces this once it lands, with scrubbing and shipping; until then
// nothing this service writes carries a value that would need scrubbing.
//
// The envelope always wins: a field named like an envelope key (`event`, `level`, `service`, …) is
// dropped, as packages/server's writer drops it, so no line can be relabelled by its own fields and an
// alert matching `event` always sees the line's real event.
import type { Clock, Line, LineSink } from "@fin/db";

export interface Envelope {
  environment: string;
  release: string;
  replica: string;
  runId?: string;
}

/** The keys a line's fields may never set (spec 08 §7.2's envelope). */
export const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
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
]);

/** A line's UTF-8 size limit (spec 08 §7.2: "cut to keep the line under 8 KB"). */
export const MAX_LINE_BYTES = 8 * 1024;

export function stdoutLines(
  envelope: Envelope,
  clock: Clock,
  write: (text: string) => void,
): LineSink {
  return {
    write(line: Line) {
      const fields = Object.fromEntries(
        Object.entries(line.fields).filter(([key]) => !ENVELOPE_KEYS.has(key)),
      );
      const head: Record<string, unknown> = {
        dt: new Date(clock.now()).toISOString(),
        message: line.event,
        event: line.event,
        level: line.level,
        service: "migrate",
        environment: envelope.environment,
        release: envelope.release,
        replica: envelope.replica,
        ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
      };
      let text = JSON.stringify({ ...head, ...fields });
      if (Buffer.byteLength(text, "utf8") > MAX_LINE_BYTES) {
        text = JSON.stringify({
          ...head,
          ...Object.fromEntries(Object.keys(fields).map((k) => [k, null])),
          truncated: true,
        });
      }
      write(`${text}\n`);
    },
  };
}
