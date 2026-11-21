// The migrate service's lines (spec 01 §8.9; spec 08 §7.2's envelope): one JSON object per line on
// stdout, which Railway keeps and Better Stack's shipper reads. Fields are IDs, names and codes only.
// packages/server's writer (P0-D) replaces this once it lands, with scrubbing and shipping; until then
// nothing this service writes carries a value that would need scrubbing.
import type { Clock, Line, LineSink } from "@fin/db";

export interface Envelope {
  environment: string;
  release: string;
  replica: string;
  runId?: string;
}

const MAX_LINE = 8 * 1024;

export function stdoutLines(
  envelope: Envelope,
  clock: Clock,
  write: (text: string) => void,
): LineSink {
  return {
    write(line: Line) {
      const record: Record<string, unknown> = {
        dt: clock.now().toISOString(),
        message: line.event,
        event: line.event,
        level: line.level,
        service: "migrate",
        environment: envelope.environment,
        release: envelope.release,
        replica: envelope.replica,
        ...(envelope.runId === undefined ? {} : { runId: envelope.runId }),
        ...line.fields,
      };
      let text = JSON.stringify(record);
      if (text.length > MAX_LINE) {
        text = JSON.stringify({
          ...record,
          ...Object.fromEntries(Object.keys(line.fields).map((k) => [k, null])),
          truncated: true,
        });
      }
      write(`${text}\n`);
    },
  };
}
