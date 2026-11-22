// This package's lines read the way Better Stack receives them: the LineSink a test hands the
// package writes each line through @fin/server's Telemetry, which builds the envelope, drops the
// fields that share its names, scrubs, caps and ships. A test that reads MemoryLineSink sees the
// fields as written; one that reads these sees what is left of them.
import { capture, type Line } from "@fin/server/testing";
import { systemClock } from "../src/ports/clock.ts";
import { ID_PREFIXES, newId } from "../src/ports/ids.ts";
import type { LineSink } from "../src/ports/log.ts";

export interface ShippedSink {
  /** The sink to give the package. */
  readonly lines: LineSink;
  /** The request ID of the unit `unit` runs. */
  readonly requestId: string;
  /** Runs `work` as one unit of work, as a request does, so its lines ship as one batch. */
  unit<T>(work: () => Promise<T>): Promise<T>;
  /** Waits for every send and returns the lines shipped so far, in order. */
  shipped(): Promise<Line[]>;
}

export function shippedSink(): ShippedSink {
  const captured = capture({ ship: true });
  const { telemetry } = captured;
  const requestId = newId(ID_PREFIXES.request, systemClock);
  return {
    lines: { write: (event, level, fields) => telemetry.log(event, fields, level) },
    requestId,
    unit: (work) => telemetry.withUnit({ requestId }, work),
    async shipped() {
      await telemetry.flush(1000);
      return captured.shipped.flat();
    },
  };
}
