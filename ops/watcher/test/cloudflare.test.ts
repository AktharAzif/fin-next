import { describe, expect, it } from "vitest";
import { makeContext } from "../src/checks/common.ts";
import { rules } from "../src/checks/zone.ts";
import { CloudflareReader } from "../src/cloudflare.ts";
import {
  cloudflareFetch,
  healthyWorld,
  type Paging,
  type Recorded,
  settingsFor,
  ZONE_ID,
} from "./world.ts";

const RULESETS = `/zones/${ZONE_ID}/rulesets`;

/** A world whose zone holds 57 rule sets, the last of them holding a fin_next_ rule. */
function crowded(paging: Paging) {
  const world = healthyWorld();
  for (let i = 0; i < 46; i += 1) {
    world.rulesets.push({ id: `rs-old-${i}`, kind: "managed", phase: `managed_${i}` });
  }
  world.rulesets.push({ id: "rs-late", kind: "zone", phase: "http_request_origin" });
  world.otherRulesets["rs-late"] = [{ id: "r", ref: "fin_next_late", expression: "true" }];
  world.paging[RULESETS] = paging;
  return world;
}

async function lateRuleFound(paging: Paging) {
  const world = crowded(paging);
  const recorded: Recorded[] = [];
  const ctx = makeContext(
    await settingsFor(healthyWorld()),
    new CloudflareReader("t", cloudflareFetch(world, recorded)),
  );
  const failures = await rules.run(ctx);
  const pages = recorded.filter((r) => new URL(r.url).pathname.endsWith("/rulesets")).length;
  return { failures: failures.map((f) => `${f.target}/${f.detail}`), pages };
}

describe("the reader's lists", () => {
  it("expects 57 rule sets in the crowded world", () => {
    expect(crowded("total_pages").rulesets.length).toBe(57);
  });

  for (const paging of ["total_pages", "total_count", "none", "cursor"] as const) {
    it(`reads every page when the list pages by ${paging}`, async () => {
      const { failures, pages } = await lateRuleFound(paging);
      expect(failures).toEqual(["http_request_origin/ruleset_unexpected"]);
      expect(pages).toBe(2);
    });
  }

  it("stops after a list that ignores paging, without counting its items twice", async () => {
    const world = crowded("ignore");
    const reader = new CloudflareReader("t", cloudflareFetch(world));
    const items = await reader.list(RULESETS);
    expect(items.length).toBe(57);
  });

  it("fails the read when a list claims more items than its pages hold", async () => {
    const world = healthyWorld();
    const fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: [],
          result_info: { page: 1, per_page: 50, count: 0, total_count: 3 },
        }),
        { status: 200 },
      );
    const reader = new CloudflareReader("t", fetch);
    await expect(reader.list(RULESETS)).rejects.toThrow(/answered/);
    expect(world.rulesets.length).toBeGreaterThan(0);
  });

  it("fails the read when the page limit is reached", async () => {
    let page = 0;
    const fetch = async () => {
      page += 1;
      return new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: Array.from({ length: 50 }, (_, i) => ({ id: `p${page}-${i}` })),
        }),
        { status: 200 },
      );
    };
    const reader = new CloudflareReader("t", fetch);
    await expect(reader.list(RULESETS)).rejects.toThrow(/answered 0/);
  });
});
