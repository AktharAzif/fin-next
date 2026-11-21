// The ingress check (ARCHITECTURE §5.5; spec 01 §6.4; spec 02 §2.2 step 2; AC-P0-07; T08-40), first
// after private health. A request is tunnel traffic only when its TCP peer is a current replica of
// the service's own connector services AND its host's `Fin-Ingress-Proof` matches [current,
// previous]. Anything else loses every Cloudflare-set header and gets 403 with an alerting
// `ingress.untrusted_peer` line. The proof is removed before any handler and never logged, from
// the Request and from Node's message behind it; `Host` must be a configured host (421 otherwise);
// the request target is canonical (one leading `/`, no `\`, no dot segment, no encoded alias of a
// plain character: 400 otherwise); and the Request handlers see is rebuilt on the URL the app uses,
// the configured origin plus the raw target, so the path checked here is the path routed.
import type { MiddlewareHandler } from "hono";
import type { HostRole } from "../config/index.ts";
import type { FinContext, FinEnv, IngressFacts } from "../http/context.ts";
import {
  dropRequestHeaders,
  isSafeTarget,
  peerAddress,
  publicUrl,
  rawTarget,
} from "../http/facts.ts";
import type { Telemetry } from "../telemetry/telemetry.ts";
import type { ConnectorPeers } from "./peers.ts";
import { type IngressProofs, PROOF_HEADER } from "./proofs.ts";

/** Headers only Cloudflare and the connector may set; dropped from anything but tunnel traffic. */
export const EDGE_HEADERS = [
  "cf-connecting-ip",
  "cf-connecting-ipv6",
  "cf-ipcountry",
  "cf-visitor",
  "cf-ray",
  "cf-worker",
  "cf-ew-via",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cf-access-client-id",
  "x-real-ip",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-forwarded-port",
  "true-client-ip",
  PROOF_HEADER,
] as const;

export type UntrustedReason = "peer_unknown" | "proof_missing" | "proof_mismatch";

export interface IngressCheckOptions {
  peers: ConnectorPeers;
  proofs: IngressProofs;
  /** Host role to its configured public origin. */
  origins: Partial<Record<HostRole, string>>;
  telemetry: Telemetry;
  /** Answers a refusal; the front door builds the problem document. */
  refuse: (c: FinContext, status: 400 | 403 | 421, code: string) => Response;
}

function visitorScheme(value: string | undefined): IngressFacts["scheme"] {
  if (value === undefined) return undefined;
  try {
    const scheme = (JSON.parse(value) as { scheme?: unknown }).scheme;
    return scheme === "http" || scheme === "https" ? scheme : undefined;
  } catch {
    return undefined;
  }
}

function bounded(value: string | undefined, pattern: RegExp): string | undefined {
  return value !== undefined && pattern.test(value) ? value : undefined;
}

export function ingressCheck(options: IngressCheckOptions): MiddlewareHandler<FinEnv> {
  const hosts = new Map<string, { role: HostRole; origin: string }>();
  for (const [role, origin] of Object.entries(options.origins) as [HostRole, string][]) {
    hosts.set(new URL(origin).host.toLowerCase(), { role, origin });
  }

  return async (c, next) => {
    const target = rawTarget(c);
    if (!isSafeTarget(target)) {
      c.set("outcome", "refused");
      c.set("reason", "ingress.bad_target");
      return options.refuse(c, 400, "invalid");
    }
    const peer = peerAddress(c);
    const proof = c.req.header(PROOF_HEADER);
    const host = (c.req.header("host") ?? "").toLowerCase();
    const configured = hosts.get(host);

    let peerOk = options.peers.has(peer);
    const proofOk =
      configured !== undefined
        ? options.proofs.matches(configured.role, proof)
        : options.proofs.matchesAny(proof);
    if (!peerOk && proofOk && (await options.peers.refreshOnDemand())) {
      peerOk = options.peers.has(peer);
    }

    if (!peerOk || !proofOk) {
      dropRequestHeaders(c, EDGE_HEADERS);
      const reason: UntrustedReason = !peerOk
        ? "peer_unknown"
        : proof === undefined
          ? "proof_missing"
          : "proof_mismatch";
      options.telemetry.log(
        "ingress.untrusted_peer",
        { reason, ...(configured !== undefined ? { role: configured.role } : {}) },
        "warn",
      );
      c.set("outcome", "refused");
      c.set("reason", `ingress.${reason}`);
      return options.refuse(c, 403, "forbidden");
    }

    if (configured === undefined) {
      dropRequestHeaders(c, [PROOF_HEADER]);
      c.set("outcome", "refused");
      c.set("reason", "ingress.host");
      return options.refuse(c, 421, "misdirected");
    }

    const url = publicUrl(configured.origin, target);
    if (url === undefined) {
      dropRequestHeaders(c, [PROOF_HEADER]);
      c.set("outcome", "refused");
      c.set("reason", "ingress.bad_target");
      return options.refuse(c, 400, "invalid");
    }

    const facts: IngressFacts = {
      role: configured.role,
      host,
      publicUrl: url,
      clientIp: bounded(c.req.header("cf-connecting-ip"), /^[0-9a-fA-F.:]{2,45}$/),
      country: bounded(c.req.header("cf-ipcountry"), /^[A-Z0-9]{2}$/),
      scheme: visitorScheme(c.req.header("cf-visitor")),
      cfRay: bounded(c.req.header("cf-ray"), /^[A-Za-z0-9-]{8,40}$/),
    };
    dropRequestHeaders(c, [PROOF_HEADER], url);
    c.set("ingress", facts);
    await next();
  };
}
