// The Hono environment every Fin HTTP service shares: Node's request and response as bindings, and
// the per-request facts the front door sets before any handler runs.
import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import type { HostRole } from "../config/index.ts";
import type { Actor, Outcome } from "../telemetry/lines.ts";

/** What tunnel traffic may tell the app once the ingress check has passed (ARCHITECTURE §5.5). */
export interface IngressFacts {
  role: HostRole;
  host: string;
  /** The configured public origin joined with the raw request target, never built from Host. */
  publicUrl: string;
  clientIp: string | undefined;
  country: string | undefined;
  scheme: "http" | "https" | undefined;
  cfRay: string | undefined;
}

/** The Cloudflare Access identity Fin Admin's API half verified on this request (spec 02 §10.5). */
export interface AccessIdentity {
  sub: string;
  /** Personal data (PD-4): compared with the staff table, never logged (a withheld field name). */
  email: string;
}

export interface FinVariables {
  requestId: string;
  outcome: Outcome | undefined;
  reason: string | undefined;
  errorId: string | undefined;
  actor: Actor;
  ingress: IngressFacts | undefined;
  /** Set on Fin Admin's API half once the Access token is valid. */
  access: AccessIdentity | undefined;
  /** The route template for the request line, when a layer knows it better than the router. */
  route: string | undefined;
}

export type FinEnv = { Bindings: Partial<HttpBindings>; Variables: FinVariables };

export type FinContext = Context<FinEnv>;

/** Marks the request line's outcome and bounded reason. */
export function markOutcome(c: FinContext, outcome: Outcome, reason?: string): void {
  c.set("outcome", outcome);
  if (reason !== undefined) c.set("reason", reason);
}
