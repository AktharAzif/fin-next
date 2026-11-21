// The connector peer set (ARCHITECTURE §5.5 check 1; spec 01 §6.4). The addresses of the service's
// own connector services come from resolving `<connector>.railway.internal` every 15 seconds, with
// `::ffff:` forms normalised. A request from an unknown peer that carries a valid proof triggers one
// re-resolve, at most once a second, so a connector redeploy does not drop traffic.
import { isIP } from "node:net";
import type { Clock } from "@fin/core";
import { PRIVATE_SUFFIX, type ResolvedAddress } from "../dns/railway-lookup.ts";

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
  resolveAll: (hostname: string) => Promise<ResolvedAddress[]>;
  clock: Clock;
  refreshMs?: number;
  minOnDemandMs?: number;
}

export class ConnectorPeers {
  private addresses = new Set<string>();
  private readonly services: readonly string[];
  private readonly resolveAll: ConnectorPeersOptions["resolveAll"];
  private readonly clock: Clock;
  private readonly refreshMs: number;
  private readonly minOnDemandMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lastOnDemand = Number.NEGATIVE_INFINITY;
  private pending: Promise<void> | undefined;
  private resolvedOnce = false;

  constructor(options: ConnectorPeersOptions) {
    this.services = options.services;
    this.resolveAll = options.resolveAll;
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

  /** Whether the peers have been resolved at least once. */
  get ready(): boolean {
    return this.resolvedOnce;
  }

  has(address: string | undefined): boolean {
    return address !== undefined && this.addresses.has(normaliseAddress(address));
  }

  /**
   * Re-resolves every connector service. A service that fails keeps the addresses the resolver's
   * stale cache still holds; a service with no answer at all contributes none.
   */
  refresh(): Promise<void> {
    if (this.pending !== undefined) return this.pending;
    this.pending = (async () => {
      const next = new Set<string>();
      let anyAnswer = false;
      await Promise.all(
        this.services.map(async (service) => {
          try {
            for (const answer of await this.resolveAll(`${service}${PRIVATE_SUFFIX}`)) {
              if (isIP(answer.address) !== 0) next.add(normaliseAddress(answer.address));
            }
            anyAnswer = true;
          } catch {
            // dns.lookup_failed is written by the resolver; the service has no peers this round.
          }
        }),
      );
      if (anyAnswer || next.size > 0) {
        this.addresses = next;
        this.resolvedOnce = true;
      }
    })().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** One on-demand re-resolve, at most once a second; resolves false when throttled. */
  async refreshOnDemand(): Promise<boolean> {
    const now = this.clock.now();
    if (now - this.lastOnDemand < this.minOnDemandMs) return false;
    this.lastOnDemand = now;
    await this.refresh();
    return true;
  }
}
