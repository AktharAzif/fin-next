// node packages/testing/src/email/cli.ts [--port <n>]
//
// Runs the email sink for a journey run (default port: EMAIL_SINK_PORT). A `test` image's email
// adapter posts to <origin>/messages; journeys read it through EmailSinkReader. Message content is
// never printed: one line per start and stop only.
import { parseArgs } from "node:util";
import { EMAIL_SINK_PORT } from "../static-host/apps.ts";
import { startEmailSink } from "./sink.ts";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { port: { type: "string" } }, strict: true });
  const port = Number(values.port ?? EMAIL_SINK_PORT);
  if (!Number.isInteger(port) || port < 0) throw new Error("--port is a port number");
  const running = await startEmailSink({ port });
  process.stdout.write(
    `${JSON.stringify({ event: "process.start", service: "email-sink", origin: running.origin })}\n`,
  );
  const stop = () => {
    void running.close().finally(() => process.exit(0));
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `email-sink: ${error instanceof Error ? error.message : "could not start"}\n`,
  );
  process.exit(78);
});
