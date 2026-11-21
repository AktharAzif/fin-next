// The key check (spec 05 §2.1 steps 12 to 19; §4.7; ARCHITECTURE §7.7; [SA-19]), for a request to
// a known /v4 route, after load shedding, the https check, CORS, the route lookup and Fin-Version:
//   12. From the docs origin, an Authorization header must hold a well-formed Sandbox key whose
//       checksum verifies with this deployment's salt, or the answer is 403 sandbox_key_required,
//       before any lookup (Try it never sends anything else, spec 05 §9).
//   13. `Authorization: Bearer <key>`: shape and checksum with this deployment's salt.
//   14. The negative filter: a key ID found not to exist in the last 60 seconds is refused at once,
//       counted for the address's refused-key window in this replica's memory (shed.ts), so it
//       turns into 429 after as many refusals as a key ID with a row does.
//   15. One statement: the record, the address's refused-key window and the live_keys switch.
//   16. The constant-time compare across the pepper chain; revoked; expired; the allowlist. Every
//       refusal is the same 401 (only `request_id` differs), or 429 once the address's refused-key
//       window is full; the reason goes into the request line as `keyReason` only.
//   17. A Production key: the organisation not live, paused, or the live_keys switch on.
//   18. The route's policy: key kind, scopes and mode.
//   19. The key's window, 600 calls a minute, with the draft-11 RateLimit headers.
// A statement that fails answers 503 and alerts: the check never fails open.
import type { Clock } from "@fin/core";
import { hmacSha256, type Keyring, toBase64Url } from "@fin/crypto";
import {
  judgeKey,
  KEY_WINDOW_LIMIT,
  type KeyReason,
  type KeyStore,
  keyWindowKey,
  liveGate,
  precheck,
  REFUSED_KEYS_LIMIT,
  refusedWindowKey,
  type Scope,
  type VerifiedKey,
  WINDOW_SECONDS,
} from "@fin/keys";
import type { FinContext } from "@fin/server/http";
import type { Telemetry } from "@fin/server/telemetry";
import type { LastUsed } from "./last-used.ts";
import { FROM_DOCS_DETAIL, problemAnswer, UNAUTHENTICATED_DETAIL } from "./problems.ts";
import { factsOf, timed } from "./request-line.ts";
import { addressKey, type Shedder } from "./shed.ts";

/** A /v4 operation's policy as the edge enforces it (spec 05 §6.1's RoutePolicy, the edge's part). */
export interface EdgeRoute {
  operationId: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  keyKind: "any" | "full_access";
  scopes: readonly Scope[];
  mode: "any" | "sandbox_only";
}

export interface KeyCheckDeps {
  store: KeyStore;
  peppers: Keyring;
  salt: string;
  shedder: Shedder;
  /** Step 23's gate: "last used" at most once a minute per key. */
  lastUsed: LastUsed;
  clock: Clock;
  docsOrigin: string;
  telemetry: Telemetry;
}

const VERIFIED = new WeakMap<Request, VerifiedKey>();

/** The key this request's check passed, if any. */
export function verifiedKeyOf(c: FinContext): VerifiedKey | undefined {
  return VERIFIED.get(c.req.raw);
}

/** The refused-key window's key: a keyed hash of the address, so no window holds an address. */
export function addressHash(peppers: Keyring, address: string): string {
  const key = peppers.key(peppers.inUse) as Uint8Array;
  return toBase64Url(hmacSha256(key, `refused_keys:${address}`)).slice(0, 22);
}

function unauthenticated(c: FinContext, deps: KeyCheckDeps, reason: KeyReason): Response {
  const facts = factsOf(c);
  facts.keyReason = reason;
  c.set("outcome", "refused");
  c.set("reason", "unauthenticated");
  return problemAnswer(c, deps.docsOrigin, {
    code: "unauthenticated",
    detail:
      facts.fromDocs === true
        ? `${UNAUTHENTICATED_DETAIL}${FROM_DOCS_DETAIL}`
        : UNAUTHENTICATED_DETAIL,
  });
}

/** 429 past the address's refused-key window (spec 05 §3.7), the refusal's reason in the line only. */
function refusedKeysLimited(
  c: FinContext,
  deps: KeyCheckDeps,
  reason: KeyReason,
  secondsLeft: number,
): Response {
  const facts = factsOf(c);
  facts.keyReason = reason;
  facts.rateLimited = true;
  facts.violatedPolicies = ["refused_keys"];
  c.set("outcome", "refused");
  c.set("reason", "rate_limited");
  return problemAnswer(c, deps.docsOrigin, {
    code: "rate_limited",
    extensions: { violated_policies: ["refused_keys"] },
    headers: { "retry-after": String(secondsLeft) },
  });
}

function unavailable(c: FinContext, deps: KeyCheckDeps, reason: string): Response {
  c.set("outcome", "error");
  c.set("reason", reason);
  return problemAnswer(c, deps.docsOrigin, {
    code: "temporarily_unavailable",
    headers: { "retry-after": "5" },
  });
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[0-9A-Z_]{1,40}$/.test(code)
    ? code
    : error instanceof Error
      ? error.name
      : "unknown";
}

/**
 * Runs steps 12 to 19 for `route`; answers the refusal, or null with the key recorded for the
 * handler, its facts on the request line and the RateLimit headers to add to the answer.
 */
export async function checkKey(
  c: FinContext,
  deps: KeyCheckDeps,
  route: EdgeRoute,
): Promise<{ refused: Response } | { key: VerifiedKey; headers: Record<string, string> }> {
  const facts = factsOf(c);
  const header = c.req.header("authorization");
  const fromDocs = c.req.header("origin") === deps.docsOrigin;
  if (fromDocs) facts.fromDocs = true;

  // 12: Try it sends only this deployment's Sandbox keys.
  if (fromDocs && header !== undefined) {
    const docs = precheck(header, deps.salt);
    if (!docs.ok || docs.key.mode !== "test") {
      facts.keyReason = docs.ok ? "live_from_docs" : docs.reason;
      c.set("outcome", "refused");
      c.set("reason", "sandbox_key_required");
      return { refused: problemAnswer(c, deps.docsOrigin, { code: "sandbox_key_required" }) };
    }
  }

  // 13: shape and checksum, no I/O.
  const pre = precheck(header, deps.salt);
  if (!pre.ok) return { refused: unauthenticated(c, deps, pre.reason) };
  const key = pre.key;
  facts.keyId = key.id;

  // 14: the negative filter, counted for the address's refused-key window without a statement.
  const clientIp = c.get("ingress")?.clientIp;
  const address = addressKey(clientIp);
  if (deps.shedder.knownUnknown(key.id)) {
    const seen = deps.shedder.refuse(address);
    if (seen.count > REFUSED_KEYS_LIMIT) {
      return { refused: refusedKeysLimited(c, deps, "unknown", seen.secondsLeft) };
    }
    return { refused: unauthenticated(c, deps, "unknown") };
  }

  // 15: the one statement.
  const refusedWindow = refusedWindowKey(addressHash(deps.peppers, address));
  let lookup: Awaited<ReturnType<KeyStore["lookup"]>>;
  try {
    lookup = await timed(c, () => deps.store.lookup(key.id, refusedWindow));
  } catch (error) {
    deps.telemetry.log("key.lookup_failed", { code: errorCode(error) }, "error");
    return { refused: unavailable(c, deps, "key.lookup_failed") };
  }
  deps.shedder.seenRefused(address, lookup.refusedCount);

  // 16: the compare, revocation, expiry and the allowlist.
  const judged = judgeKey({
    key,
    record: lookup.record,
    peppers: deps.peppers,
    now: deps.clock.now(),
    clientIp,
  });
  if (!judged.ok) {
    if (judged.reason === "unknown" && lookup.record === null) deps.shedder.rememberUnknown(key.id);
    if (judged.reason === "pepper_missing") {
      deps.telemetry.log("key.pepper_missing", { keyId: key.id }, "error");
    }
    let count: Awaited<ReturnType<KeyStore["count"]>>;
    try {
      count = await timed(c, () => deps.store.count(refusedWindow));
    } catch (error) {
      deps.telemetry.log(
        "rate_limiter.failed",
        { code: errorCode(error), policy: "refused_keys" },
        "error",
      );
      return { refused: unavailable(c, deps, "rate_limiter.failed") };
    }
    // The larger of the window in Postgres and what this replica answered from its filter.
    const seen = deps.shedder.refuse(address, count.count);
    if (seen.count > REFUSED_KEYS_LIMIT) {
      return {
        refused: refusedKeysLimited(
          c,
          deps,
          judged.reason,
          count.count > REFUSED_KEYS_LIMIT ? count.secondsLeft : seen.secondsLeft,
        ),
      };
    }
    return { refused: unauthenticated(c, deps, judged.reason) };
  }
  const verified = judged.key;
  facts.orgId = verified.organizationId;
  facts.mode = verified.mode === "live" ? "live" : "sandbox";
  c.set("actor", "api_key");

  // 17: a Production key's organisation and the live_keys switch.
  const live = liveGate(verified, lookup.liveKeysOn);
  if (live !== null) {
    c.set("outcome", live === "temporarily_unavailable" ? "error" : "refused");
    c.set("reason", live === "temporarily_unavailable" ? "live_keys_switch" : live);
    return { refused: problemAnswer(c, deps.docsOrigin, { code: live }) };
  }

  // 18: the route's policy.
  if (route.mode === "sandbox_only" && verified.mode === "live") {
    c.set("outcome", "refused");
    c.set("reason", "sandbox_only");
    return { refused: problemAnswer(c, deps.docsOrigin, { code: "sandbox_only" }) };
  }
  if (route.keyKind === "full_access" && verified.kind !== "sk") {
    c.set("outcome", "refused");
    c.set("reason", "policy.full_access");
    return {
      refused: problemAnswer(c, deps.docsOrigin, {
        code: "forbidden",
        detail: "Use a full-access key for this.",
      }),
    };
  }
  const missing =
    verified.kind === "sk" ? [] : route.scopes.filter((s) => !verified.scopes.includes(s));
  if (missing.length > 0) {
    c.set("outcome", "refused");
    c.set("reason", "policy.scope");
    return {
      refused: problemAnswer(c, deps.docsOrigin, {
        code: "forbidden",
        detail: `This key needs the ${missing[0]} scope.`,
      }),
    };
  }

  // 19: the key's window.
  let window: Awaited<ReturnType<KeyStore["count"]>>;
  try {
    window = await timed(c, () => deps.store.count(keyWindowKey(verified.id)));
  } catch (error) {
    deps.telemetry.log("rate_limiter.failed", { code: errorCode(error), policy: "key" }, "error");
    return { refused: unavailable(c, deps, "rate_limiter.failed") };
  }
  const headers = {
    "ratelimit-policy": `"key";q=${KEY_WINDOW_LIMIT};w=${WINDOW_SECONDS}`,
    ratelimit: `"key";r=${Math.max(0, KEY_WINDOW_LIMIT - window.count)};t=${window.secondsLeft}`,
  };
  if (window.count > KEY_WINDOW_LIMIT) {
    facts.rateLimited = true;
    facts.violatedPolicies = ["key"];
    c.set("outcome", "refused");
    c.set("reason", "rate_limited");
    return {
      refused: problemAnswer(c, deps.docsOrigin, {
        code: "rate_limited",
        extensions: { violated_policies: ["key"] },
        headers: { ...headers, "retry-after": String(window.secondsLeft) },
      }),
    };
  }
  VERIFIED.set(c.req.raw, verified);
  return { key: verified, headers };
}
