// The door skeleton (spec 01 §4.5, §6.4; ARCHITECTURE §4.4, §7.9). `api` answers only `/healthz`,
// `/readyz` and signed calls that the door matrix lists. Until the matrix and the Ed25519 caller
// signatures land, no operation is listed, so every other request is an outside request: 403 with
// an alerting `api.outside_request` line, whose `reason` says whether it carried a signature.
import { dropRequestHeaders, type FinEnv, type RequestOptions, refuse } from "@fin/server/http";
import { EDGE_HEADERS } from "@fin/server/ingress";
import type { Handler, MiddlewareHandler } from "hono";

export const CALLER_SIGNATURE_HEADER = "fin-caller-signature";

/** Internal calls never forward Cloudflare's headers; any that arrive are dropped first. */
export function dropEdgeHeaders(): MiddlewareHandler<FinEnv> {
  return async (c, next) => {
    dropRequestHeaders(c, EDGE_HEADERS);
    await next();
  };
}

export function outsideRequest(options: RequestOptions): Handler<FinEnv> {
  return (c) => {
    const reason =
      c.req.header(CALLER_SIGNATURE_HEADER) === undefined ? "unsigned" : "not_in_matrix";
    options.telemetry.log("api.outside_request", { reason, method: c.req.method }, "warn");
    c.set("route", "door");
    c.set("outcome", "refused");
    c.set("reason", `door.${reason}`);
    return refuse(options, c, 403, "forbidden");
  };
}
