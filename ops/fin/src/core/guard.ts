// The allow-list guard (orchestrator decision BD-11). Every Cloudflare write that names a host (a
// DNS record, a Workers route, an Access application or policy, an Email Sending domain, a zone
// rule's hosts) is checked here before it is sent:
//
//   - the zone itself is checked first: bindZone() takes Cloudflare's own answer for the zone and
//     refuses unless it is the overlay's zone, in the overlay's account (and, when the overlay
//     names one, with the ID it names). Until then every check that concerns the zone refuses, and
//     the zone ID every zone write uses is the one bindZone() checked (`guard.zoneId`), never an
//     ID taken on trust from the overlay;
//   - the name must sit under the overlay's zone; the apex, `@` and any wildcard are refused;
//   - the apex DMARC record (`_dmarc` at the zone) is refused whatever the overlay says;
//   - a name that is, or sits under, a label in the overlay's neverTouch list is refused (the other
//     product's records);
//   - the label must be in allowedNames.labels, or in spikeOnly or fallbackOnly when the run was
//     given --spike or --fallback;
//   - a Workers route's path is exactly `/*` or `/api/*`, never `/api*` (spec 01 §7.5);
//   - a zone rule's ref starts with `fin_next_`, so no other product's rule is ever touched;
//   - every object Fin names for itself in the account (tunnels, scripts, tokens, the Access
//     application and policy) starts with `fin-next-<env>-`.

import { RefusedError } from "./errors.ts";
import { type Overlay, underNeverTouch } from "./overlay.ts";

export const RULE_REF_PREFIX = "fin_next_";
const ROUTE_PATHS = new Set(["/*", "/api/*"]);
const CF_ID = /^[0-9a-f]{32}$/;

export interface GuardFlags {
  /** Allow the spike-only labels (S-01's throwaway hosts). */
  spike?: boolean;
  /** Allow the fallback-only labels (the per-app API hosts of spec 01 §7.12). */
  fallback?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class Guard {
  readonly #zone: string;
  readonly #accountId: string;
  readonly #expectedZoneId: string | undefined;
  readonly #environment: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #spike: ReadonlySet<string>;
  readonly #fallback: ReadonlySet<string>;
  readonly #never: readonly string[];
  readonly #flags: GuardFlags;
  #zoneId: string | undefined;

  constructor(overlay: Overlay, flags: GuardFlags = {}) {
    const lower = (labels: readonly string[]) => new Set(labels.map((l) => l.toLowerCase()));
    this.#zone = overlay.zone.toLowerCase();
    this.#accountId = overlay.cloudflare.accountId;
    this.#expectedZoneId = overlay.cloudflare.zoneId;
    this.#environment = overlay.environment;
    this.#allowed = lower(overlay.allowedNames.labels);
    this.#spike = lower(overlay.allowedNames.spikeOnly);
    this.#fallback = lower(overlay.allowedNames.fallbackOnly);
    this.#never = overlay.neverTouch.labels.map((l) => l.toLowerCase());
    this.#flags = flags;
  }

  /**
   * Checks Cloudflare's answer for the zone (`GET /zones/{id}`, or the one zone that
   * `GET /zones?name=<zone>&account.id=<account>` returns) and binds the guard to it: the zone
   * must be the overlay's zone, in the overlay's account, and carry the overlay's zone ID when the
   * overlay names one. Returns the zone's ID, which is then `guard.zoneId`.
   */
  bindZone(answer: unknown): string {
    const account = isRecord(answer) ? answer.account : undefined;
    if (
      !isRecord(answer) ||
      typeof answer.id !== "string" ||
      !CF_ID.test(answer.id) ||
      typeof answer.name !== "string" ||
      !isRecord(account) ||
      typeof account.id !== "string"
    ) {
      throw new RefusedError(
        "the zone Cloudflare returned has an unexpected shape; nothing is sent",
      );
    }
    if (answer.name.trim().toLowerCase().replace(/\.$/, "") !== this.#zone) {
      throw new RefusedError(
        "the zone ID names a zone other than the overlay's zone; nothing is sent (check cloudflare.zoneId)",
      );
    }
    if (account.id !== this.#accountId) {
      throw new RefusedError(
        "the zone belongs to an account other than the overlay's cloudflare.accountId; nothing is sent",
      );
    }
    if (this.#expectedZoneId !== undefined && answer.id !== this.#expectedZoneId) {
      throw new RefusedError(
        "the overlay's cloudflare.zoneId is not the ID of the overlay's zone; nothing is sent",
      );
    }
    if (this.#zoneId !== undefined && this.#zoneId !== answer.id) {
      throw new RefusedError("the guard is already bound to another zone; nothing is sent");
    }
    this.#zoneId = answer.id;
    return answer.id;
  }

  /** Whether bindZone() has checked the zone. */
  get zoneBound(): boolean {
    return this.#zoneId !== undefined;
  }

  /** The checked zone ID: the only zone ID a zone read or write may use. */
  get zoneId(): string {
    return this.#requireZone("a zone call");
  }

  /** Checks a zone-wide write (a zone setting) and returns the checked zone ID to send it to. */
  checkZoneWrite(what: string): string {
    return this.#requireZone(what);
  }

  #requireZone(what: string): string {
    if (this.#zoneId === undefined) {
      throw new RefusedError(
        `${what}: the zone has not been checked against the overlay's zone and account (bindZone); nothing is sent`,
      );
    }
    return this.#zoneId;
  }

  /**
   * Checks a DNS name or hostname that a write would touch and returns its label under the zone.
   * `what` names the write for the refusal message.
   */
  checkName(name: string, what: string): string {
    this.#requireZone(what);
    const host = name.trim().toLowerCase().replace(/\.$/, "");
    if (host === "" || host === "@") throw new RefusedError(`${what}: the zone apex is refused`);
    if (host.includes("*")) throw new RefusedError(`${what}: a wildcard name is refused`);
    if (host === this.#zone) throw new RefusedError(`${what}: the zone apex is refused`);
    const suffix = `.${this.#zone}`;
    if (!host.endsWith(suffix)) {
      throw new RefusedError(`${what}: ${host} is not under the environment's zone`);
    }
    const label = host.slice(0, -suffix.length);
    if (label === "" || label.startsWith(".") || label.includes("..")) {
      throw new RefusedError(`${what}: ${host} is not a valid name`);
    }
    if (label === "_dmarc") {
      throw new RefusedError(`${what}: the zone's own _dmarc record is never written`);
    }
    if (underNeverTouch(label, this.#never)) {
      throw new RefusedError(`${what}: ${host} is on, or under, the overlay's never-touch list`);
    }
    if (this.#allowed.has(label)) return label;
    if (this.#spike.has(label)) {
      if (this.#flags.spike === true) return label;
      throw new RefusedError(`${what}: ${host} is a spike-only name; pass --spike to use it`);
    }
    if (this.#fallback.has(label)) {
      if (this.#flags.fallback === true) return label;
      throw new RefusedError(`${what}: ${host} is a fallback-only name; pass --fallback to use it`);
    }
    throw new RefusedError(`${what}: ${host} is not on the overlay's allow-list`);
  }

  /** Checks a Workers route pattern: an allowed host and a path of exactly `/*` or `/api/*`. */
  checkRoutePattern(pattern: string): void {
    const slash = pattern.indexOf("/");
    if (slash <= 0) throw new RefusedError(`route ${pattern}: a pattern is <host>/<path>`);
    const host = pattern.slice(0, slash);
    const path = pattern.slice(slash);
    if (/^https?:/i.test(pattern))
      throw new RefusedError(`route ${pattern}: no scheme in a pattern`);
    this.checkName(host, `route ${pattern}`);
    if (path === "/api*") {
      throw new RefusedError(
        `route ${pattern}: /api* also matches /apix and has a specificity problem; use /api/*`,
      );
    }
    if (!ROUTE_PATHS.has(path)) {
      throw new RefusedError(`route ${pattern}: the path must be /* or /api/*`);
    }
  }

  /** Checks that a zone rule is Fin's own, by its ref. */
  checkRuleRef(ref: string | undefined, what: string): void {
    this.#requireZone(what);
    if (ref === undefined || !ref.startsWith(RULE_REF_PREFIX) || !/^[a-z0-9_]+$/.test(ref)) {
      throw new RefusedError(
        `${what}: only rules whose ref starts with ${RULE_REF_PREFIX} are written or changed`,
      );
    }
  }

  /** Checks a name Fin gives its own account-level object (no zone involved). */
  checkOwnName(name: string, what: string): void {
    const prefix = `fin-next-${this.#environment}-`;
    if (!name.startsWith(prefix) || !/^[a-z0-9-]+$/.test(name)) {
      throw new RefusedError(`${what}: ${name} must start with ${prefix}`);
    }
  }
}
