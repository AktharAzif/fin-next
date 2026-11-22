// The line shapes (ARCHITECTURE §10.2; spec 08 §7.2). Event names will be typed against the
// monitoring catalogue (ops/monitoring/catalog/*.ts) once P0-F lands it; until then an event name is
// any bounded code, checked at run time.
import type { Environment, ServiceName } from "../config/index.ts";

export type Level = "info" | "warn" | "error";

export interface Envelope {
  /** RFC 3339 UTC with milliseconds, from the unit's Clock. */
  dt: string;
  /** Equal to `event` (Railway needs `message`). */
  message: string;
  event: string;
  level: Level;
  service: ServiceName;
  environment: Environment;
  /** The 40-hex commit SHA (FIN_RELEASE). */
  release: string;
  replica: string;
  requestId?: string;
  runId?: string;
  truncated?: true;
}

export type Actor =
  | "api_key"
  | "session"
  | "staff"
  | "link"
  | "anonymous"
  | "provider_webhook"
  | "browser_report"
  | "service";

export type Outcome = "ok" | "refused" | "shed" | "error";

/** The `request` line's own fields (spec 08 §7.2). */
export interface RequestFields {
  method: string;
  route: string;
  status: number;
  statusClass: "1xx" | "2xx" | "3xx" | "4xx" | "5xx";
  durationMs: number;
  dbMs: number;
  dbQueries: number;
  providerMs: number;
  providerCalls: number;
  bytesOut: number;
  cfRay: string | null;
  actor: Actor;
  outcome: Outcome;
  reason?: string;
  errorId?: string;
  orgId?: string;
  keyId?: string;
  userId?: string;
  staffId?: string;
  mode?: "sandbox" | "live";
  rateLimited?: boolean;
  stepUp?: "window" | "intent";
}

export type Fields = Readonly<Record<string, unknown>>;

/** The keys a caller's fields may never set: the envelope's own. */
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

export function statusClass(status: number): RequestFields["statusClass"] {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}
