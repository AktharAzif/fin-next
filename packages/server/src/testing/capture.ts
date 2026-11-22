// Test helpers: a telemetry whose stdout and shipped batches are captured in memory. Imported only
// by *.test.ts files (here and in the packages and apps built on @fin/server).
import { gunzipSync } from "node:zlib";
import { createManualClock, type ManualClock } from "@fin/core";
import type { ServiceName } from "../config/index.ts";
import { Reporter } from "../report.ts";
import type { Transport } from "../telemetry/ship.ts";
import { Telemetry } from "../telemetry/telemetry.ts";

export const TEST_RELEASE = "0123456789abcdef0123456789abcdef01234567";
export const TEST_START = Date.UTC(2026, 10, 21, 8, 0, 0);

export type Line = Record<string, unknown>;

export interface Captured {
  telemetry: Telemetry;
  reporter: Reporter;
  clock: ManualClock;
  stdout: Line[];
  shipped: Line[][];
  /** Every line written to stdout with this event name. */
  events(name: string): Line[];
}

export function capture(
  options: { service?: ServiceName; ship?: boolean; transport?: Transport } = {},
): Captured {
  const clock = createManualClock(TEST_START);
  const stdout: Line[] = [];
  const shipped: Line[][] = [];
  const transport: Transport | undefined =
    options.transport ??
    (options.ship === true
      ? async (body) => {
          shipped.push(JSON.parse(gunzipSync(body).toString("utf8")) as Line[]);
          return 202;
        }
      : undefined);
  const telemetry = new Telemetry({
    service: options.service ?? "console",
    environment: "ci",
    release: TEST_RELEASE,
    replica: "test",
    clock,
    stdout: (text) => stdout.push(JSON.parse(text) as Line),
    ...(transport !== undefined ? { transport } : {}),
  });
  const reporter = new Reporter({
    dsn: undefined,
    release: TEST_RELEASE,
    environment: "ci",
    service: options.service ?? "console",
    telemetry,
  });
  return {
    telemetry,
    reporter,
    clock,
    stdout,
    shipped,
    events: (name) => stdout.filter((line) => line.event === name),
  };
}

/** A random 32-byte proof in base64url, made at run time (never committed). */
export function randomProof(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

/** The base environment of a deployed-shaped process, minus secrets. */
export function baseEnv(
  service: ServiceName,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    FIN_SERVICE: service,
    FIN_ENVIRONMENT: "ci",
    FIN_RELEASE: TEST_RELEASE,
    FIN_DRAIN_SECONDS: "40",
    PORT: "8080",
    ...extra,
  };
}
