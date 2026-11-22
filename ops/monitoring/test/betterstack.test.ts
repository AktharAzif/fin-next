import { describe, expect, it } from "vitest";
import { BetterStackClient, HOSTS, PATHS } from "../src/betterstack.ts";

const TOKEN = ["telemetry", "team", "token"].join("-");
const item = (id: number) => ({ id: String(id), attributes: { name: `s-${id}` } });

/** A client whose list answers are `pages`, one per call, the last repeated. */
function client(pages: readonly unknown[]) {
  let call = 0;
  const reader = new BetterStackClient("telemetry", TOKEN, async () => {
    const page = pages[Math.min(call, pages.length - 1)];
    call += 1;
    return new Response(JSON.stringify(page), { status: 200 });
  });
  return { reader, calls: () => call };
}

describe("the Better Stack client's lists", () => {
  it("reads every page to a next link of null", async () => {
    const { reader, calls } = client([
      {
        data: [item(1), item(2)],
        pagination: { next: `${HOSTS.telemetry}${PATHS.sources}?page=2` },
      },
      { data: [item(3)], pagination: { next: null } },
    ]);
    expect((await reader.list(PATHS.sources)).map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(calls()).toBe(2);
  });

  it("fails a list whose answer does not say where it ends", async () => {
    for (const page of [
      { data: [item(1)] },
      { data: [item(1)], pagination: null },
      { data: [item(1)], pagination: {} },
      { data: [item(1)], pagination: { next: 2 } },
    ]) {
      const { reader } = client([page]);
      await expect(reader.list(PATHS.sources), JSON.stringify(page)).rejects.toThrow(
        /GET \/api\/v3\/sources: /,
      );
    }
  });

  it("fails a list whose next link comes back", async () => {
    const next = `${HOSTS.telemetry}${PATHS.sources}?page=2`;
    const { reader, calls } = client([
      { data: [item(1)], pagination: { next } },
      { data: [item(2)], pagination: { next } },
    ]);
    await expect(reader.list(PATHS.sources)).rejects.toThrow(/GET \/api\/v3\/sources: /);
    expect(calls()).toBe(2);
  });
});
