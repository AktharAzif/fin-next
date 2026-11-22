// The connector peer set (ARCHITECTURE §5.5 check 1; spec 01 §6.4). The addresses of the service's
// own connector services come from resolving `<connector>.railway.internal` every 15 seconds, with
// `::ffff:` forms normalised. A request from an unknown peer that carries a valid proof triggers one
// re-resolve, at most once a second, so a connector redeploy does not drop traffic.
//
// Every round asks the private resolver for a fresh answer (never its 10-second cache), and the set
// is exactly that round's answers: when a connector's name fails to resolve, the resolver serves
// its last answer for up to five minutes (spec 01 §6.4), and after that the connector has no
// address here. A set with no address is not ready.
import { isIP } from "node:net";
import type { Clock } from "@fin/core";
import { PRIVATE_SUFFIX, type PrivateResolver } from "../dns/railway-lookup.ts";

export const REFRESH_MS = 15_000;
export const MIN_ON_DEMAND_MS = 1_000;

/** Normalises a socket address: lower case, an IPv4-mapped IPv6 address as plain IPv4. */
export function normaliseAddress(address: string): string {
  const lower = address.trim().toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped?.[1] !== undefined) return mapped[1];
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMapped?.[1] !== undefined && hexMapped[2] !== undefined) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return lower;
}

export interface ConnectorPeersOptions {
  services: readonly string[];
  /**
   * The private-DNS resolver (`ServiceContext.resolver`). Each round calls
   * `resolveAll(name, { fresh: true })`: DNS now, a stale answer for at most five minutes if it fails.
   */
  resolver: Pick<PrivateResolver, "resolveAll">;
  clock: Clock;
  refreshMs?: number;
  minOnDemandMs?: number;
}

export class ConnectorPeers {
  private addresses = new Set<string>();
  private readonly services: readonly string[];
  private readonly resolver: ConnectorPeersOptions["resolver"];
  private readonly clock: Clock;
  private readonly refreshMs: number;
  private readonly minOnDemandMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastOnDemand = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;

  constructor(options: ConnectorPeersOptions) {
    this.services = options.services;
    this.resolver = options.resolver;
    this.clock = options.clock;
    this.refreshMs = options.refreshMs ?? REFRESH_MS;
    this.minOnDemandMs = options.minOnDemandMs ?? MIN_ON_DEMAND_MS;
  }

  /** Resolves now and every 15 seconds after. Never called at module scope. */
  async start(): Promise<void> {
    await this.refresh();
    if (this.timer === undefined) {
      this.timer = setInterval(() => void this.refresh(), this.refreshMs);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Whether some connector has a current address (readiness's `connector_peers`). */
  get ready(): boolean {
    return this.addresses.size > 0;
  }

  has(address: string | undefined): boolean {
    return address !== undefined && this.addresses.has(normaliseAddress(address));
  }

  /**
   * Re-resolves every connector service. A service the resolver has no answer for, fresh or
   * stale, contributes no address.
   */
  refresh(): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    this.pending = (async () => {
      const next = new Set<string>();
      await Promise.all(
        this.services.map(async (service) => {
          try {
            const answers = await this.resolver.resolveAll(`${service}${PRIVATE_SUFFIX}`, {
              fresh: true,
            });
            for (const answer of answers) {
              if (isIP(answer.address) !== 0) next.add(normaliseAddress(answer.address));
            }
          } catch {
            // dns.lookup_failed is written by the resolver; the service has no peers this round.
          }
        }),
      );
      this.addresses = next;
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /**
   * One on-demand re-resolve, at most once a second. A request that arrives while a re-resolve
   * is running waits for it rather than being refused. Resolves false only when throttled.
   */
  async refreshOnDemand(): Promise<boolean> {
    if (this.pending !== undefined) {
      await this.pending;
      return true;
    }
    const now = this.clock.now();
    if (now - this.lastOnDemand < this.minOnDemandMs) return false;
    this.lastOnDemand = now;
    await this.refresh();
    return true;
  }
}
