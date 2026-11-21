// The one place a Fin process writes to standard output (biome allows the console only under
// packages/server/src/log/). Every line reaching here has already been scrubbed and capped.
//
// Standard output is Railway's copy; the shipment to Better Stack is the record (ARCHITECTURE
// §10.3). So when stdout fails (its reader has gone, as when the log collector stops: EPIPE), the
// writes stop and nothing else does. Unheard, the stream's 'error' would be an uncaught exception,
// the crash handler's own line to the same stdout another, and so on without end: the process
// would neither serve nor exit, SIGTERM included.

export type StdoutWriter = (line: string) => void;

/** What a writer needs of a stream: `process.stdout`, or a test's stand-in. */
export interface LineStream {
  write(chunk: string): boolean;
  on(event: "error", listener: (error: unknown) => void): unknown;
}

const NODE_CODE = /^(?:E[A-Z0-9_]{2,40}|ERR_[A-Z0-9_]{2,60})$/;

function errorCodeOf(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && NODE_CODE.test(code) ? code : "unexpected";
}

/**
 * A writer of lines to `stream` that stops for good at the stream's first error, whether it is
 * thrown or emitted, and never throws itself; `onFailure` hears of it once, with Node's code.
 */
export function streamWriter(
  stream: LineStream,
  onFailure: (errorCode: string) => void = () => undefined,
): StdoutWriter {
  let failed = false;
  const fail = (error: unknown): void => {
    if (failed) return;
    failed = true;
    try {
      onFailure(errorCodeOf(error));
    } catch {
      // Whoever listens is not allowed to break the writer.
    }
  };
  stream.on("error", fail);
  return (line) => {
    if (failed) return;
    try {
      stream.write(`${line}\n`);
    } catch (error) {
      fail(error);
    }
  };
}

let stdout: StdoutWriter | undefined;
let stdoutFailure: string | undefined;
const failureListeners: ((errorCode: string) => void)[] = [];

/**
 * Writes one line to stdout. Railway keeps it as its copy; Better Stack gets the shipped one.
 * The first call also listens for errors on stderr, which Fin never writes but Node may (a
 * warning): a reader gone there must not end the process either.
 */
export const writeStdout: StdoutWriter = (line) => {
  if (stdout === undefined) {
    process.stderr.on("error", () => undefined);
    stdout = streamWriter(process.stdout, (errorCode) => {
      stdoutFailure = errorCode;
      for (const listener of failureListeners.splice(0)) listener(errorCode);
    });
  }
  stdout(line);
};

/**
 * Calls `listener` once, when stdout fails (at once, if it already has), so the process can say
 * so where its lines still go.
 */
export function onStdoutFailure(listener: (errorCode: string) => void): void {
  if (stdoutFailure !== undefined) listener(stdoutFailure);
  else failureListeners.push(listener);
}
