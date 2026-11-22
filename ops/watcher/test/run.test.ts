import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runWatcher, type WatcherEnv } from "../src/run.ts";
import { log, safe } from "../src/ship.ts";
import {
  cloudflareFetch,
  healthyWorld,
  PUBLIC_TUNNEL,
  type Recorded,
  settingsFor,
  type World,
} from "./world.ts";

const INGEST = "ingest.example.com";
const HEARTBEAT = "https://heartbeat.example.com/beat/abc";
const TOKEN = ["source", "token", "value"].join("-");

interface Harness {
  recorded: Recorded[];
  shipped: unknown[][];
  pings: string[];
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

function harness(world: World, ingestStatus = 202): Harness {
  const recorded: Recorded[] = [];
  const shipped: unknown[][] = [];
  const pings: string[] = [];
  const cf = cloudflareFetch(world, recorded);
  return {
    recorded,
    shipped,
    pings,
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.hostname === INGEST) {
        const body = Buffer.from(init?.body as ArrayBuffer);
        shipped.push(JSON.parse(gunzipSync(body).toString("utf8")) as unknown[]);
        return new Response(null, { status: ingestStatus });
      }
      if (url.hostname === "heartbeat.example.com") {
        pings.push(input);
        return new Response("ok");
      }
      return cf(input, init);
    },
  };
}

async function env(world: World): Promise<WatcherEnv> {
  return {
    FIN_WATCHER_SETTINGS: JSON.stringify(await settingsFor(world)),
    FIN_CF_TOKEN: "read-only-token",
    FIN_TELEMETRY_HOST: INGEST,
    FIN_TELEMETRY_TOKEN: TOKEN,
    FIN_HEARTBEAT_WATCHER_URL: HEARTBEAT,
  };
}

const deps = (h: Harness) => ({
  fetch: h.fetch,
  now: () => Date.UTC(2026, 10, 21, 10, 0, 0),
  randomId: () => "r1",
});

describe("one minute of watching", () => {
  it("writes one watcher.run line, ships it gzipped with the source token, then pings", async () => {
    const world = healthyWorld();
    const h = harness(world);
    const result = await runWatcher(await env(world), deps(h));
    expect(result.failures).toEqual([]);
    expect(result.healthy).toBe(true);
    expect(h.shipped).toHaveLength(1);
    expect(h.shipped[0]).toEqual([
      {
        dt: "2026-11-21T10:00:00.000Z",
        message: "watcher.run",
        event: "watcher.run",
        level: "info",
        service: "watcher",
        environment: "staging",
        release: "e".repeat(40),
        replica: "watcher",
        runId: "watch_r1",
        checks: 9,
        failed: 0,
        durationMs: 0,
      },
    ]);
    const post = h.recorded.find((r) => new URL(r.url).hostname === INGEST);
    expect(post).toBeUndefined(); // the ingest call is not a Cloudflare call
    expect(h.pings).toEqual([HEARTBEAT]);
  });

  it("calls Cloudflare with GET only and the read-only token", async () => {
    const world = healthyWorld();
    const h = harness(world);
    await runWatcher(await env(world), deps(h));
    expect(h.recorded.length).toBeGreaterThan(10);
    for (const r of h.recorded) {
      expect(r.method).toBe("GET");
      expect(r.headers.get("authorization")).toBe("Bearer read-only-token");
    }
  });

  it("writes one watcher.check_failed per failure after the run line", async () => {
    const world = healthyWorld();
    world.connections[PUBLIC_TUNNEL] = [];
    world.bots = { fight_mode: true };
    const h = harness(world);
    const result = await runWatcher(await env(world), deps(h));
    const lines = h.shipped[0] as Record<string, unknown>[];
    expect(lines.map((l) => l.event)).toEqual([
      "watcher.run",
      "watcher.check_failed",
      "watcher.check_failed",
    ]);
    expect(lines[0]).toMatchObject({ level: "warn", checks: 9, failed: 2 });
    expect(lines.slice(1).map((l) => [l.check, l.target, l.detail, l.level])).toEqual([
      ["connectors", "public", "count_mismatch", "error"],
      ["zone", "bot_fight_mode", "bot_fight_on", "error"],
    ]);
    expect(result.healthy).toBe(true);
    expect(h.pings).toEqual([HEARTBEAT]);
  });

  it("turns an API refusal into a failure of that check (fail closed)", async () => {
    const world = healthyWorld();
    world.failures["/zones"] = 403;
    const h = harness(world);
    const result = await runWatcher(await env(world), deps(h));
    const zoneChecks = ["dns", "routes", "rules", "zone", "email"];
    expect(result.failures.map((f) => `${f.check}/${f.detail}`)).toEqual(
      zoneChecks.map((c) => `${c}/api_forbidden`),
    );
  });

  it("pings the failure URL when its lines could not ship", async () => {
    const world = healthyWorld();
    const h = harness(world, 401);
    const result = await runWatcher(await env(world), deps(h));
    expect(result.shipped).toBe(false);
    expect(h.pings).toEqual([`${HEARTBEAT}/fail`]);
  });

  it("retries a 5xx from ingest once", async () => {
    const world = healthyWorld();
    let calls = 0;
    const h = harness(world);
    const fetch = async (input: string, init?: RequestInit) => {
      if (new URL(input).hostname === INGEST) {
        calls += 1;
        return new Response(null, { status: calls === 1 ? 503 : 202 });
      }
      return h.fetch(input, init);
    };
    const result = await runWatcher(await env(world), { ...deps(h), fetch });
    expect(calls).toBe(2);
    expect(result.shipped).toBe(true);
  });

  it("pings the failure URL when its settings are broken or its token is missing", async () => {
    const world = healthyWorld();
    for (const broken of [
      { ...(await env(world)), FIN_WATCHER_SETTINGS: "{not json" },
      { ...(await env(world)), FIN_CF_TOKEN: "" },
    ]) {
      const h = harness(world);
      const result = await runWatcher(broken, deps(h));
      expect(result.healthy).toBe(false);
      expect(h.pings).toEqual([`${HEARTBEAT}/fail`]);
      expect(h.recorded.filter((r) => new URL(r.url).hostname === "api.cloudflare.com")).toEqual(
        [],
      );
    }
  });
});

describe("lines", () => {
  it("never carries a value outside the code alphabet", () => {
    expect(safe("count_mismatch")).toBe("count_mismatch");
    expect(safe("console/api/*")).toBe("console/api/*");
    expect(safe("a value with spaces")).toBe("redacted");
    expect(safe("person@example.com")).toBe("redacted");
    expect(safe(Number.NaN)).toBe(0);
  });

  it("keeps the envelope's fields from being overwritten", () => {
    const line = log(
      "watcher.check_failed",
      { service: "edge", event: "x", check: "dns", "bad key": 1 },
      { environment: "staging", release: "r", runId: "watch_1", now: () => 0 },
    );
    expect(line.service).toBe("watcher");
    expect(line.event).toBe("watcher.check_failed");
    expect(line.check).toBe("dns");
    expect("bad key" in line).toBe(false);
  });
});
