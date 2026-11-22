import { createManualClock } from "@fin/core";
import { describe, expect, it } from "vitest";
import { createPrivateResolver, type ResolveAll, STALE_MS } from "./railway-lookup.ts";

const A = { address: "203.0.113.10", family: 4 as const };
const B = { address: "2001:db8::10", family: 6 as const };

function setup(answers: ReturnType<ResolveAll> | (() => ReturnType<ResolveAll>)) {
  const clock = createManualClock(0);
  const failures: { target: string; stale: boolean; errorCode: string }[] = [];
  let calls = 0;
  const resolve: ResolveAll = async () => {
    calls++;
    return typeof answers === "function" ? answers() : answers;
  };
  const resolver = createPrivateResolver({ clock, onFailure: (f) => failures.push(f), resolve });
  return { clock, failures, resolver, calls: () => calls };
}

describe("the private-DNS cache", () => {
  it("caches a private name for its fresh window", async () => {
    const { resolver, clock, calls } = setup(Promise.resolve([A, B]));
    expect(await resolver.resolveAll("edge.railway.internal")).toEqual([A, B]);
    clock.advance(5_000);
    await resolver.resolveAll("EDGE.railway.internal");
    expect(calls()).toBe(1);
    clock.advance(6_000);
    await resolver.resolveAll("edge.railway.internal");
    expect(calls()).toBe(2);
  });

  it("answers stale for up to 5 minutes when a lookup fails, writing dns.lookup_failed", async () => {
    let fail = false;
    const { resolver, clock, failures } = setup(() =>
      fail
        ? Promise.reject(Object.assign(new Error("x"), { code: "ESERVFAIL" }))
        : Promise.resolve([A]),
    );
    await resolver.resolveAll("api.railway.internal");
    fail = true;
    clock.advance(60_000);
    expect(await resolver.resolveAll("api.railway.internal")).toEqual([A]);
    expect(failures).toEqual([{ target: "api", stale: true, errorCode: "ESERVFAIL" }]);
    clock.advance(STALE_MS);
    await expect(resolver.resolveAll("api.railway.internal")).rejects.toThrow();
    expect(failures.at(-1)).toEqual({ target: "api", stale: false, errorCode: "ESERVFAIL" });
  });

  it("coalesces concurrent lookups of one name", async () => {
    const { resolver, calls } = setup(new Promise((r) => setTimeout(() => r([A]), 10)));
    await Promise.all([1, 2, 3].map(() => resolver.resolveAll("x.railway.internal")));
    expect(calls()).toBe(1);
  });

  it("gives pg and fetch a lookup that answers by family and in the all form", async () => {
    const { resolver } = setup(Promise.resolve([A, B]));
    const one = await new Promise<[string, number]>((resolve, reject) =>
      resolver.lookup("postgres.railway.internal", { family: 6 }, (error, address, family) =>
        error ? reject(error) : resolve([address as string, family as number]),
      ),
    );
    expect(one).toEqual(["2001:db8::10", 6]);
    const all = await new Promise<unknown>((resolve, reject) =>
      resolver.lookup("postgres.railway.internal", { all: true }, (error, addresses) =>
        error ? reject(error) : resolve(addresses),
      ),
    );
    expect(all).toEqual([A, B]);
  });

  it("leaves public names to the system resolver", async () => {
    const { resolver, calls } = setup(Promise.resolve([A]));
    const address = await new Promise<string>((resolve, reject) =>
      resolver.lookup("localhost", {}, (error, a) =>
        error ? reject(error) : resolve(a as string),
      ),
    );
    expect(["127.0.0.1", "::1"]).toContain(address);
    expect(calls()).toBe(0);
  });
});
