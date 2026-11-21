// The watcher's own small sender (spec 08 §7.3): the same line shape as every Fin process, shipped
// to its Better Stack source as one gzipped JSON array per run, then a ping of its heartbeat.
// Fetch and CompressionStream only (it is a Worker: no AsyncLocalStorage, no Node).
//
// Lines carry codes and names only. Every free field is checked against a narrow alphabet before
// it is written, so nothing the Cloudflare API returns can reach a line (the watcher's scrubber
// by construction; packages/core's scrubLine replaces it once that package exists).
import type { Fetch } from "./cloudflare.ts";

export type WatcherEvent = "watcher.run" | "watcher.check_failed";
export type Level = "info" | "warn" | "error";
export type Line = Readonly<Record<string, string | number | boolean>>;

export interface LineContext {
  readonly environment: string;
  readonly release: string;
  readonly runId: string;
  readonly now: () => number;
}

const SAFE = /^[A-Za-z0-9_.:/*-]{1,96}$/;
const SHIP_TIMEOUT_MS = 3_000;

/** A value safe to write: a code or a name, or "redacted". */
export function safe(value: unknown): string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "boolean") return value;
  return typeof value === "string" && SAFE.test(value) ? value : "redacted";
}

/** Builds one line in the envelope of ARCHITECTURE §10.2. */
export function log(
  event: WatcherEvent,
  fields: Readonly<Record<string, unknown>>,
  ctx: LineContext,
  level: Level = "info",
): Line {
  const line: Record<string, string | number | boolean> = {
    dt: new Date(ctx.now()).toISOString(),
    message: event,
    event,
    level,
    service: "watcher",
    environment: safe(ctx.environment) as string,
    release: safe(ctx.release) as string,
    replica: "watcher",
    runId: safe(ctx.runId) as string,
  };
  for (const [key, value] of Object.entries(fields)) {
    if (/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(key) && !(key in line)) line[key] = safe(value);
  }
  return line;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** Ships the lines. Returns whether Better Stack accepted them (one retry, as the transport). */
export async function ship(
  lines: readonly Line[],
  host: string | undefined,
  token: string | undefined,
  fetchImpl: Fetch,
): Promise<boolean> {
  if (host === undefined || token === undefined || !HOST.test(host) || token === "") return false;
  const body = await gzip(JSON.stringify(lines));
  const send = () =>
    fetchImpl(`https://${host}/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
      },
      body,
      signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
      redirect: "error",
    });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await send();
      if (response.ok) return true;
      if (response.status < 500 && response.status !== 429) return false;
    } catch {
      // A network error: retry once.
    }
  }
  return false;
}

/** Pings the heartbeat, or its failure URL. Returns whether the ping was accepted. */
export async function ping(
  url: string | undefined,
  failed: boolean,
  fetchImpl: Fetch,
): Promise<boolean> {
  if (url === undefined || !url.startsWith("https://")) return false;
  try {
    const target = failed ? `${url.replace(/\/+$/, "")}/fail` : url;
    const response = await fetchImpl(target, {
      method: "POST",
      signal: AbortSignal.timeout(SHIP_TIMEOUT_MS),
      redirect: "error",
    });
    return response.ok;
  } catch {
    return false;
  }
}
