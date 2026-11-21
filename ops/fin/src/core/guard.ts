// The allow-list guard (orchestrator decision BD-11). Every Cloudflare write that names a host (a
// DNS record, a Workers route, an Access application or policy, an Email Sending domain, a zone
// rule's hosts) is checked here before it is sent:
//
//   - the name must sit under the overlay's zone; the apex, `@` and any wildcard are refused;
//   - the apex DMARC record (`_dmarc` at the zone) is refused whatever the overlay says;
//   - a label in the overlay's neverTouch list is refused (the other product's records);
//   - the label must be in allowedNames.labels, or in spikeOnly or fallbackOnly when the run was
//     given --spike or --fallback;
//   - a Workers route's path is exactly `/*` or `/api/*`, never `/api*` (spec 01 §7.5);
//   - a zone rule's ref starts with `fin_next_`, so no other product's rule is ever touched;
//   - every object Fin names for itself in the account (tunnels, scripts, tokens, the Access
//     application and policy) starts with `fin-next-<env>-`.

import { RefusedError } from "./errors.ts";
import type { Overlay } from "./overlay.ts";

export const RULE_REF_PREFIX = "fin_next_";
const ROUTE_PATHS = new Set(["/*", "/api/*"]);

export interface GuardFlags {
  /** Allow the spike-only labels (S-01's throwaway hosts). */
  spike?: boolean;
  /** Allow the fallback-only labels (the per-app API hosts of spec 01 §7.12). */
  fallback?: boolean;
}

export class Guard {
  readonly #zone: string;
  readonly #environment: string;
  readonly #allowed: ReadonlySet<string>;
  readonly #spike: ReadonlySet<string>;
  readonly #fallback: ReadonlySet<string>;
  readonly #never: ReadonlySet<string>;
  readonly #flags: GuardFlags;

  constructor(overlay: Overlay, flags: GuardFlags = {}) {
    const lower = (labels: readonly string[]) => new Set(labels.map((l) => l.toLowerCase()));
    this.#zone = overlay.zone.toLowerCase();
    this.#environment = overlay.environment;
    this.#allowed = lower(overlay.allowedNames.labels);
    this.#spike = lower(overlay.allowedNames.spikeOnly);
    this.#fallback = lower(overlay.allowedNames.fallbackOnly);
    this.#never = lower(overlay.neverTouch.labels);
    this.#flags = flags;
  }

  /**
   * Checks a DNS name or hostname that a write would touch and returns its label under the zone.
   * `what` names the write for the refusal message.
   */
  checkName(name: string, what: string): string {
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
    if (this.#never.has(label) || this.#never.has(`${label}.${this.#zone}`)) {
      throw new RefusedError(`${what}: ${host} is on the overlay's never-touch list`);
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
    if (ref === undefined || !ref.startsWith(RULE_REF_PREFIX) || !/^[a-z0-9_]+$/.test(ref)) {
      throw new RefusedError(
        `${what}: only rules whose ref starts with ${RULE_REF_PREFIX} are written or changed`,
      );
    }
  }

  /** Checks a name Fin gives its own account-level object. */
  checkOwnName(name: string, what: string): void {
    const prefix = `fin-next-${this.#environment}-`;
    if (!name.startsWith(prefix) || !/^[a-z0-9-]+$/.test(name)) {
      throw new RefusedError(`${what}: ${name} must start with ${prefix}`);
    }
  }
}
