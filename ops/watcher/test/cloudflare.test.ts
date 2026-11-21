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

const items = (count: number, prefix = "item") =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}` }));

function envelope(result: unknown[], resultInfo?: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      result,
      ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
    }),
    { status: 200 },
  );
}

interface ServerOptions {
  /** Whether the list honours the page number (default) or answers page 1 to every request. */
  readonly page?: "honour" | "ignore";
  /** Whether the list honours per_page (default) or answers the whole list on one page. */
  readonly perPage?: "honour" | "ignore";
  /** The most items the list answers on one page, whatever per_page asks. */
  readonly cap?: number;
  /** The result_info the list gives with every page (none by default). */
  readonly totals?: Record<string, unknown>;
}

/** A list endpoint that pages as `options` says, behind a reader. */
function server(list: readonly unknown[], options: ServerOptions = {}) {
  const reader = new CloudflareReader("t", async (input: string) => {
    const q = new URL(input).searchParams;
    const asked = Number(q.get("per_page") ?? "20");
    const size = options.perPage === "ignore" ? list.length : Math.min(asked, options.cap ?? asked);
    const page = options.page === "ignore" ? 1 : Number(q.get("page") ?? "1");
    return envelope(list.slice((page - 1) * size, page * size), options.totals);
  });
  return { reader };
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

  // Without totals the reader cannot take a short page as the end (a list may answer fewer items
  // than asked for), so it reads on to the empty page that proves it.
  const expectedPages = { total_pages: 2, total_count: 2, cursor: 2, none: 3 } as const;
  for (const paging of ["total_pages", "total_count", "none", "cursor"] as const) {
    it(`reads every page when the list pages by ${paging}`, async () => {
      const { failures, pages } = await lateRuleFound(paging);
      expect(failures).toEqual(["http_request_origin/ruleset_unexpected"]);
      expect(pages).toBe(expectedPages[paging]);
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

  it("fails the read when a list ignores the page number although its totals say more remain", async () => {
    for (const totals of [
      { total_pages: 3, total_count: 120 },
      { total_count: 120 },
      { total_pages: 3 },
      // Totals that disagree: one page by its count of pages, 120 items by its count of items.
      { total_pages: 1, total_count: 120 },
    ]) {
      const list = server(items(120), { page: "ignore", totals });
      await expect(list.reader.list(RULESETS), JSON.stringify(totals)).rejects.toThrow(
        /answered 0/,
      );
    }
  });

  it("reads on past a short page when the list caps its page size and gives no totals", async () => {
    const list = server(items(57), { cap: 20 });
    expect((await list.reader.list(RULESETS)).length).toBe(57);
  });

  it("fails the read when a list gives no totals and answers the same full page again", async () => {
    const list = server(items(120), { page: "ignore" });
    await expect(list.reader.list(RULESETS)).rejects.toThrow(/answered 0/);
  });

  it("accepts a whole list of exactly one page that ignores paging altogether", async () => {
    const list = server(items(50), { page: "ignore", perPage: "ignore" });
    expect((await list.reader.list(RULESETS)).length).toBe(50);
  });

  it("follows a cursor past an empty page, and fails on a cursor that comes back", async () => {
    const answers = [
      { result: items(3), cursor: "c1" },
      { result: [], cursor: "c2" },
      { result: items(5, "late"), cursor: "" },
    ];
    let call = 0;
    const reader = new CloudflareReader("t", async () => {
      const answer = answers[Math.min(call, answers.length - 1)];
      call += 1;
      return envelope(answer?.result ?? [], { cursor: answer?.cursor ?? "" });
    });
    expect((await reader.list(RULESETS)).length).toBe(8);

    let loops = 0;
    const stuck = new CloudflareReader("t", async () => {
      loops += 1;
      return envelope(items(2), { cursor: "same" });
    });
    await expect(stuck.list(RULESETS)).rejects.toThrow(/answered 0/);
    expect(loops).toBe(2);
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
