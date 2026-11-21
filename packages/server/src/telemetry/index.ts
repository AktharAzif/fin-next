// The telemetry module (spec 08 §7.3). It needs Node built-ins and @fin/core only, so the connector
// supervisor, which has no third-party dependency, ships its lines through it too, and writes
// stdout through the same writer.
export {
  type LineStream,
  onStdoutFailure,
  type StdoutWriter,
  streamWriter,
  writeStdout,
} from "../log/stdout.ts";
export { byteLength, capLine, MAX_LINE_BYTES } from "./cap.ts";
export {
  type Actor,
  ENVELOPE_KEYS,
  type Envelope,
  type Fields,
  type Level,
  type Outcome,
  type RequestFields,
  statusClass,
} from "./lines.ts";
export {
  batches,
  betterStackTransport,
  gzipLines,
  MAX_BATCH_BYTES,
  SEND_TIMEOUT_MS,
  type SendResult,
  sendWithRetry,
  type Transport,
} from "./ship.ts";
export {
  type BackgroundFailureHook,
  currentTelemetry,
  flush,
  installTelemetry,
  log,
  QUEUE_INTERVAL_MS,
  QUEUE_LIMIT,
  shipAfter,
  Telemetry,
  type TelemetryOptions,
  type UnitStart,
  withUnit,
} from "./telemetry.ts";
