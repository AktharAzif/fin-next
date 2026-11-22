// MEASUREMENT ONLY (CI fix 3, apps/console; throwaway, never merged). A Vitest setup file for the
// console's db project: it times every request the test client sends and every Postgres query
// (the test's own, as the superuser, and the API half's, as the console's login, attributed to the
// request in flight), and prints one line per test with the split, plus one line for the requests
// made in hooks before it. Nothing here changes what a test does or asserts.
import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach } from "vitest";
import { Client } from "../apps/console/test/client.ts";

const PHASE = process.env.FIN_SPLIT_PHASE ?? "full";
const OUT = "/tmp/ci-f3-split.log";
const ADMIN_USER = (() => {
  try {
    return decodeURIComponent(new URL(process.env.FIN_TEST_DATABASE_URL ?? "").username);
  } catch {
    return "postgres";
  }
})();

interface Req {
  what: string;
  status: number;
  ms: number;
  dbN: number;
  dbMs: number;
}

interface Bucket {
  reqs: Req[];
  adminN: number;
  adminMs: number;
  serverOutsideN: number;
  serverOutsideMs: number;
}

const fresh = (): Bucket => ({
  reqs: [],
  adminN: 0,
  adminMs: 0,
  serverOutsideN: 0,
  serverOutsideMs: 0,
});

let bucket = fresh();
let current: Req | null = null;
let lastEnd = performance.now();
let startedAt = 0;

function shape(path: string): string {
  const bare = path.split("?")[0] ?? path;
  return bare
    .split("/")
    .map((seg) => (seg.length >= 16 && /\d/.test(seg) ? ":id" : seg))
    .join("/");
}

// Every request of the test client.
const proto = Client.prototype as unknown as {
  call: (...args: unknown[]) => Promise<{ status: number }>;
};
const originalCall = proto.call;
proto.call = async function (this: unknown, ...args: unknown[]) {
  const entry: Req = {
    what: `${String(args[0])} ${shape(String(args[1]))}`,
    status: 0,
    ms: 0,
    dbN: 0,
    dbMs: 0,
  };
  const t = performance.now();
  current = entry;
  try {
    const reply = await originalCall.apply(this, args);
    entry.status = reply.status;
    return reply;
  } finally {
    entry.ms = performance.now() - t;
    current = null;
    bucket.reqs.push(entry);
  }
};

// Every Postgres query, by whom.
function noteQuery(user: string | undefined, ms: number, during: Req | null): void {
  if (user === ADMIN_USER) {
    bucket.adminN += 1;
    bucket.adminMs += ms;
  } else if (during !== null) {
    during.dbN += 1;
    during.dbMs += ms;
  } else {
    bucket.serverOutsideN += 1;
    bucket.serverOutsideMs += ms;
  }
}

try {
  const pg = createRequire(new URL("../apps/console/package.json", import.meta.url))("pg") as {
    Client: { prototype: { query: (...args: unknown[]) => unknown } };
  };
  const qproto = pg.Client.prototype;
  const originalQuery = qproto.query;
  qproto.query = function (this: { user?: string }, ...args: unknown[]) {
    const t = performance.now();
    const during = current;
    const user = this.user;
    const done = () => {
      try {
        noteQuery(user, performance.now() - t, during);
      } catch {
        // never fail a test over a measurement
      }
    };
    const last = args[args.length - 1];
    if (typeof last === "function") {
      const callback = last as (...cb: unknown[]) => unknown;
      args[args.length - 1] = function (this: unknown, ...cb: unknown[]) {
        done();
        return callback.apply(this, cb);
      };
      return originalQuery.apply(this, args);
    }
    const first = args[0] as { submit?: unknown } | null | undefined;
    if (first !== null && typeof first === "object" && typeof first.submit === "function") {
      return originalQuery.apply(this, args);
    }
    const result = originalQuery.apply(this, args) as { then?: unknown } | undefined;
    if (result !== undefined && result !== null && typeof result.then === "function") {
      (result as Promise<unknown>).then(done, done);
    }
    return result;
  };
} catch (error) {
  emit(`ci-f3-split-error pg patch: ${String(error)}`);
}

function emit(line: string): void {
  try {
    // biome-ignore lint/suspicious/noConsole: measurement-only split line
    console.info(line);
  } catch {
    // ignore
  }
  try {
    appendFileSync(OUT, `${line}\n`);
  } catch {
    // ignore
  }
}

function summary(b: Bucket): string {
  const reqMs = b.reqs.reduce((a, r) => a + r.ms, 0);
  const dbN = b.reqs.reduce((a, r) => a + r.dbN, 0);
  const dbMs = b.reqs.reduce((a, r) => a + r.dbMs, 0);
  const by = new Map<string, { n: number; ms: number; dbN: number; dbMs: number }>();
  for (const r of b.reqs) {
    const e = by.get(r.what) ?? { n: 0, ms: 0, dbN: 0, dbMs: 0 };
    e.n += 1;
    e.ms += r.ms;
    e.dbN += r.dbN;
    e.dbMs += r.dbMs;
    by.set(r.what, e);
  }
  const routes = [...by]
    .sort((x, y) => y[1].ms - x[1].ms)
    .map(([w, e]) => `${w} x${e.n} ${Math.round(e.ms)}ms (db ${e.dbN}q ${Math.round(e.dbMs)}ms)`)
    .join("; ");
  const seq = b.reqs.map((r) => `${r.what} ${r.status} ${Math.round(r.ms)}`).join(", ");
  return (
    `requests=${b.reqs.length} requestMs=${Math.round(reqMs)} serverDb=${dbN}q/${Math.round(dbMs)}ms` +
    ` adminDb=${b.adminN}q/${Math.round(b.adminMs)}ms` +
    ` serverDbOutside=${b.serverOutsideN}q/${Math.round(b.serverOutsideMs)}ms` +
    ` | by route: ${routes} | sequence: ${seq}`
  );
}

function label(ctx: { task: { name: string; file?: { name?: string } } }): string {
  return `${ctx.task.file?.name ?? "?"} > ${ctx.task.name}`;
}

beforeEach((ctx) => {
  try {
    const now = performance.now();
    if (bucket.reqs.length > 0 || bucket.adminN > 0) {
      emit(
        `ci-f3-split ${PHASE} HOOKS-BEFORE ${label(ctx)} | gap=${Math.round(now - lastEnd)}ms | ${summary(bucket)}`,
      );
    }
    bucket = fresh();
    startedAt = now;
  } catch {
    // ignore
  }
});

afterEach((ctx) => {
  try {
    const now = performance.now();
    const total = now - startedAt;
    const reqMs = bucket.reqs.reduce((a, r) => a + r.ms, 0);
    emit(
      `ci-f3-split ${PHASE} TEST ${label(ctx)} | total=${Math.round(total)}ms rest=${Math.round(total - reqMs - bucket.adminMs)}ms | ${summary(bucket)}`,
    );
    bucket = fresh();
    lastEnd = performance.now();
  } catch {
    // ignore
  }
});
