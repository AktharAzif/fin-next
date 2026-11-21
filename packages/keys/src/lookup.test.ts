// The edge's statements as the store reads their rows (spec 05 §2.1 steps 15, 16 and 19): the switch
// and the windows read as what they are, or the store throws, which the edge answers 503 for. A row
// that lost a column never reads as "the live_keys switch is off" or "no refusals yet": the check
// never fails open. The statements themselves run on Postgres 18 in schema.db.test.ts.
import { describe, expect, it } from "vitest";
import { keyStore, type Queryable } from "./lookup.ts";

function answering(row: Record<string, unknown> | undefined): Queryable {
  return {
    query: async <R extends object>() => ({ rows: (row === undefined ? [] : [row]) as R[] }),
  };
}

const RECORD = {
  id: "ABCDEFGHJK",
  organization_id: "org_01jd0000000000000000000000",
  mode: "test",
  kind: "rk",
  scopes: ["customers:read"],
  ip_allowlist: [],
  hash: new Uint8Array(32),
  pepper_versions: [1],
  expires_at: null,
  revoked_at: null,
  rolling_until: null,
  org_live_status: "not_enabled",
};

describe("the lookup", () => {
  it("reads the record, the refused-key count and the live_keys switch", async () => {
    const store = keyStore(answering({ ...RECORD, refused_count: "3", live_keys_on: false }));
    const lookup = await store.lookup("ABCDEFGHJK", "edge:refused_keys:x");
    expect(lookup).toMatchObject({ refusedCount: 3, liveKeysOn: false });
    expect(lookup.record).toMatchObject({ id: "ABCDEFGHJK" });
    const none = keyStore(answering({ ...RECORD, id: null, refused_count: 0, live_keys_on: true }));
    expect(await none.lookup("ABCDEFGHJK", "w")).toMatchObject({
      record: null,
      liveKeysOn: true,
    });
  });

  it.each([
    ["no live_keys_on", { refused_count: 0 }],
    ["a live_keys_on that is not a boolean", { refused_count: 0, live_keys_on: "t" }],
    ["no refused_count", { live_keys_on: false }],
    ["a refused_count that is not a count", { refused_count: "many", live_keys_on: false }],
    ["a negative refused_count", { refused_count: -1, live_keys_on: false }],
  ])("throws on a row with %s", async (_label, over) => {
    await expect(
      keyStore(answering({ ...RECORD, ...over })).lookup("ABCDEFGHJK", "w"),
    ).rejects.toThrow(/did not read/);
  });

  it("throws when the statement answers no row", async () => {
    await expect(keyStore(answering(undefined)).lookup("ABCDEFGHJK", "w")).rejects.toThrow(
      /no row/,
    );
  });
});

describe("a window's count", () => {
  it("reads the count and the seconds left, at least 1", async () => {
    expect(await keyStore(answering({ count: "31", seconds_left: 0 })).count("w")).toEqual({
      count: 31,
      secondsLeft: 1,
    });
  });

  it.each([
    ["no count", { seconds_left: 5 }],
    ["a count of nothing", { count: null, seconds_left: 5 }],
    ["a zero count", { count: 0, seconds_left: 5 }],
    ["no seconds left", { count: 1 }],
  ])("throws on a row with %s", async (_label, row) => {
    await expect(keyStore(answering(row)).count("w")).rejects.toThrow(/did not read/);
  });
});
