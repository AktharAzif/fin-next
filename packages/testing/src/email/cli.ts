// node packages/testing/src/email/cli.ts [--port <n>] [--clock <when>]
//
// Runs the email sink for a journey run (default port: EMAIL_SINK_PORT). A `test` image's email
// adapter posts to <origin>/messages; journeys read it through EmailSinkReader. Each message's
// `receivedAt` is stamped at the run's clock, as the other stand-ins sign at it: --clock is canon
// (the default, CANON_TIME), wall, or an ISO 8601 time, and FIN_E2E_CLOCK sets the same. Message
// content is never printed: one line per start and stop only.
import { parseArgs } from "node:util";
import { e2eClock, type RunClock } from "../clock.ts";
import { EMAIL_SINK_PORT } from "../static-host/apps.ts";
import { EmailSink, startEmailSink } from "./sink.ts";

function fail(message: string): never {
  process.stderr.write(`email-sink: ${message}\n`);
  process.exit(78);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { port: { type: "string" }, clock: { type: "string" } },
    strict: true,
  });
  const port = Number(values.port ?? EMAIL_SINK_PORT);
  if (!Number.isInteger(port) || port < 0) fail("--port is a port number");
  let clock: RunClock;
  try {
    clock = e2eClock(values.clock ?? process.env.FIN_E2E_CLOCK);
  } catch {
    fail("--clock (or FIN_E2E_CLOCK) is canon, wall, or an ISO 8601 time");
  }
  const running = await startEmailSink({ port, sink: new EmailSink({ now: clock.now }) });
  process.stdout.write(
    `${JSON.stringify({
      event: "process.start",
      service: "email-sink",
      origin: running.origin,
      clock: clock.setting,
    })}\n`,
  );
  const stop = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : "could not start");
});
