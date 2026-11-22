// The private-DNS cache ([P-21]; ARCHITECTURE §4.4; spec 01 §6.4). Railway's private DNS failed for
// about five minutes on 30 Sep 2026, and Node caches no lookup, so names under `railway.internal`
// get a short cache with stale answers for up to 5 minutes when a lookup fails, and every failure
// writes `dns.lookup_failed`. Public names use the normal resolver, untouched.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import type { LookupFunction } from "node:net";
import type { Clock } from "@fin/core";

export const PRIVATE_SUFFIX = ".railway.internal";
export const FRESH_MS = 10_000;
export const STALE_MS = 5 * 60_000;

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Resolves every address of a name (A and AAAA), in the resolver's order. */
export type ResolveAll = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolveAll: ResolveAll = async (hostname) => {
  const answers = await dnsLookupAsync(hostname, { all: true, order: "verbatim" });
  return answers.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export type FailureLog = (fields: { target: string; stale: boolean; errorCode: string }) => void;

interface Entry {
  addresses: ResolvedAddress[];
  at: number;
}

export function isPrivateName(hostname: string): boolean {
  return hostname.toLowerCase().endsWith(PRIVATE_SUFFIX);
}

/** The first label of a private name: the Railway service, safe to log. */
function targetOf(hostname: string): string {
  return hostname.toLowerCase().slice(0, -PRIVATE_SUFFIX.length).split(".").pop() ?? "unknown";
}

function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code) ? code : "unknown";
}

export interface ResolveOptions {
  /**
   * Ask DNS now instead of answering from the fresh cache (the connector peers, which must see a
   * redeployed connector at once). A failed lookup still falls back to a stale answer.
   */
  fresh?: boolean;
}

export interface PrivateResolver {
  /** Every address of a private name, from the cache when fresh, stale when the lookup fails. */
  resolveAll(hostname: string, options?: ResolveOptions): Promise<ResolvedAddress[]>;
  /** A `lookup` for `pg` and internal `fetch`: private names cached, public names untouched. */
  lookup: LookupFunction;
}

export function createPrivateResolver(options: {
  clock: Clock;
  onFailure: FailureLog;
  resolve?: ResolveAll;
  freshMs?: number;
  staleMs?: number;
}): PrivateResolver {
  const resolve = options.resolve ?? systemResolveAll;
  const freshMs = options.freshMs ?? FRESH_MS;
  const staleMs = options.staleMs ?? STALE_MS;
  const cache = new Map<string, Entry>();
  const inFlight = new Map<string, Promise<ResolvedAddress[]>>();

  const resolveAll = async (
    hostname: string,
    resolveOptions: ResolveOptions = {},
  ): Promise<ResolvedAddress[]> => {
    const name = hostname.toLowerCase();
    const now = options.clock.now();
    const cached = cache.get(name);
    if (resolveOptions.fresh !== true && cached !== undefined && now - cached.at < freshMs) {
      return cached.addresses;
    }
    // A lookup already in flight is as fresh as a new one would be.
    const pending = inFlight.get(name);
    if (pending !== undefined) return pending;
    const work = (async () => {
      try {
        const addresses = await resolve(name);
        if (addresses.length === 0)
          throw Object.assign(new Error("no address"), { code: "ENODATA" });
        cache.set(name, { addresses, at: options.clock.now() });
        return addresses;
      } catch (error) {
        const stale = cached !== undefined && options.clock.now() - cached.at < staleMs;
        options.onFailure({ target: targetOf(name), stale, errorCode: errorCodeOf(error) });
        if (stale) return cached.addresses;
        throw error;
      } finally {
        inFlight.delete(name);
      }
    })();
    inFlight.set(name, work);
    return work;
  };

  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    if (!isPrivateName(hostname)) {
      dnsLookup(hostname, lookupOptions, callback);
      return;
    }
    resolveAll(hostname).then(
      (addresses) => {
        const family =
          lookupOptions.family === "IPv4"
            ? 4
            : lookupOptions.family === "IPv6"
              ? 6
              : lookupOptions.family;
        const usable =
          family === 4 || family === 6 ? addresses.filter((a) => a.family === family) : addresses;
        const first = usable[0];
        if (first === undefined) {
          callback(
            Object.assign(new Error("no address of that family"), { code: "ENODATA" }),
            "",
            4,
          );
        } else if (lookupOptions.all === true) {
          (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, usable);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => callback(error as NodeJS.ErrnoException, "", 4),
    );
  };

  return { resolveAll, lookup };
}
