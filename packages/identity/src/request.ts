// What the API half tells a realm about a request, and what the realm keeps about it while the
// library runs (bound with AsyncLocalStorage, so the library's hooks can read it).
import type { RealmName } from "./config.ts";
import type { EndpointRule, GateState } from "./endpoint-policy.ts";
import type { PersonGateFacts } from "./gate.ts";
import type { LineFields, LineValue } from "./ports/log.ts";
import type { IntentBinding } from "./step-up/intents.ts";
import type { FactorFacts, PersonRow, SessionRow } from "./store.ts";

/** Given by the API half's front door (packages/web-host, P0-D) after ingress and the origin gate. */
export interface RequestContext {
  requestId: string;
  /** `CF-Connecting-IP`, trusted only because the front door drops it on non-tunnel traffic. */
  clientIp: string | null;
  userAgent: string | null;
  /** Staff realm: the Access identity the front door verified (§2.2 step 4, §10.5). */
  access?: { email: string; sub: string } | null;
  /**
   * Adds the auth fields to the API half's `request` line (§18.1). When the front door gives
   * none, the realm writes its own `request` line, so every auth request has exactly one.
   */
  annotate?: (fields: LineFields) => void;
}

export interface Prior {
  session: SessionRow;
  person: PersonRow;
  factors: FactorFacts;
  /** Developer realm only: identity.person_gate's answer. */
  facts: PersonGateFacts | null;
}

export interface RequestState {
  readonly realm: RealmName;
  readonly context: RequestContext;
  /** The network key for limits: the IPv4 address or the IPv6 /48. */
  readonly network: string;
  rule: EndpointRule | null;
  /** The live session the request arrived with. */
  prior: Prior | null;
  /**
   * The person whose ceremony lock (store.ts) this request took before it read anything of theirs:
   * the only person a session may be made for here, besides one this request created.
   */
  heldPerson: string | null;
  gate: GateState;
  /** A validated intent for a step_up_self path, consumed after the library succeeds. */
  intent: { id: string; binding: IntentBinding } | null;
  trustDevice: boolean;
  /** The developer sign-in in progress: the code request, the account, the trusted browser. */
  signIn: {
    email: string;
    codeRequestId: string | null;
    askingBrowser: boolean;
    accountExists: boolean;
    facts: PersonGateFacts | null;
    trustedBrowserId: string | null;
    signUpRequestId: string | null;
    signUpName: string | null;
  } | null;
  /** Set when this request created the account. */
  createdUserId: string | null;
  /** The template a code email uses: `confirm-email` while a sign-up request waits. */
  codeTemplate: "sign-in-code" | "confirm-email";
  /**
   * Set by `signUp()` once it has counted the code request's own limits (`code_send` per network
   * and per address) for both of its branches, so the code it then asks for is not counted twice.
   */
  codeSendCounted: boolean;
  /**
   * This request finishes an unverified authenticator's set-up, from a session that may enrol
   * (§5.4): never true at the factor step.
   */
  finishingAuthenticator: boolean;
  /** The two-factor row `/two-factor/disable` removes, read before the library deletes it. */
  removedTwoFactorId: string | null;
  /**
   * A passkey assertion whose signature counter is not above the stored one, with the challenge
   * it answers; the after-hook tells the person only once the assertion is verified (§5.3).
   */
  passkeyCounter: {
    userId: string;
    email: string;
    publicKey: string;
    expectedChallenge: string;
  } | null;
  readonly line: Record<string, LineValue>;
}

export function newRequestState(realm: RealmName, context: RequestContext): RequestState {
  return {
    realm,
    context,
    network: networkKey(context.clientIp),
    rule: null,
    prior: null,
    heldPerson: null,
    gate: "signed_out",
    intent: null,
    trustDevice: false,
    signIn: null,
    createdUserId: null,
    codeTemplate: "sign-in-code",
    codeSendCounted: false,
    finishingAuthenticator: false,
    removedTwoFactorId: null,
    passkeyCounter: null,
    // §18.1: `none` until a live session is read or made.
    line: { realm, assurance: "none" },
  };
}

/** IPv4 counts per address, IPv6 per /48 (spec 02 §5.6). */
export function networkKey(ip: string | null): string {
  if (ip === null || ip.trim() === "") return "unknown";
  const value = ip.trim().toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return `v4:${value}`;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped?.[1] !== undefined) return `v4:${mapped[1]}`;
  if (value.includes(":")) {
    const [head = "", tail = ""] = value.split("::");
    const left = head === "" ? [] : head.split(":");
    const right = tail === "" ? [] : tail.split(":");
    const groups = value.includes("::")
      ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
      : left;
    return `v6:${groups
      .slice(0, 3)
      .map((g) => g.padStart(4, "0"))
      .join(":")}::/48`;
  }
  return "unknown";
}
