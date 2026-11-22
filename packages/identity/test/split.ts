// MEASUREMENT ONLY (CI fix 3, a throwaway branch, never merged): one line per db test with its
// time split by step. Every query on a node-postgres client is timed, split by the login (a
// service login's, which is the code under test, or the superuser's: fixtures and assertions),
// with each new connection and each realm request through a Browser, by path. A total is the wall
// time with at least one of its kind in flight, so overlapping work counts once.
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterEach, beforeAll, beforeEach } from "vitest";

class Busy {
  inflight = 0;
  since = 0;
  total = 0;
  count = 0;

  enter(): void {
    this.count += 1;
    if (this.inflight === 0) this.since = performance.now();
    this.inflight += 1;
  }

  leave(): void {
    this.inflight -= 1;
    if (this.inflight === 0) this.total += performance.now() - this.since;
  }

  read(): { ms: number; n: number } {
    const open = this.inflight > 0 ? performance.now() - this.since : 0;
    return { ms: this.total + open, n: this.count };
  }
}

interface SplitState {
  service: Busy;
  superuser: Busy;
  db: Busy;
  connect: Busy;
  request: Busy;
  paths: Map<string, { n: number; ms: number }>;
}

const KEY = Symbol.for("fin.ci-f3.split");
const store = globalThis as unknown as Record<symbol, SplitState | undefined>;

function state(): SplitState {
  let found = store[KEY];
  if (found === undefined) {
    found = {
      service: new Busy(),
      superuser: new Busy(),
      db: new Busy(),
      connect: new Busy(),
      request: new Busy(),
      paths: new Map(),
    };
    store[KEY] = found;
    patch();
  }
  return found;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

function timed(original: Method, kinds: (self: unknown) => Busy[]): Method {
  return function (this: unknown, ...args: unknown[]): unknown {
    const busy = kinds(this);
    for (const b of busy) b.enter();
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      for (const b of busy) b.leave();
    };
    const last = args.at(-1);
    if (typeof last === "function") {
      args[args.length - 1] = function (this: unknown, ...result: unknown[]): unknown {
        leave();
        return (last as Method).apply(this, result);
      };
    }
    let answer: unknown;
    try {
      answer = original.apply(this, args);
    } catch (error) {
      leave();
      throw error;
    }
    if (answer instanceof Promise) answer.then(leave, leave);
    else if (typeof last !== "function") leave();
    return answer;
  };
}

function patch(): void {
  const proto = pg.Client.prototype as unknown as { query: Method; connect: Method };
  const s = () => store[KEY] as SplitState;
  const login = (self: unknown): Busy => {
    const user = String((self as { user?: unknown }).user ?? "");
    return user.startsWith("l_sat_02_") ? s().service : s().superuser;
  };
  proto.query = timed(proto.query, (self) => [login(self), s().db]);
  proto.connect = timed(proto.connect, () => [s().connect]);
}

state();

/** A realm request through a Browser, timed by its path. */
export async function timedRequest<T>(method: string, path: string, run: () => Promise<T>) {
  const s = state();
  const key = `${method} ${path.replace(/^\/api\/auth/, "")}`;
  const start = performance.now();
  s.request.enter();
  try {
    return await run();
  } finally {
    s.request.leave();
    const entry = s.paths.get(key) ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += performance.now() - start;
    s.paths.set(key, entry);
  }
}

type Kind = "service" | "superuser" | "db" | "connect" | "request";
const KINDS: readonly Kind[] = ["db", "service", "superuser", "connect", "request"];

export interface Mark {
  at: number;
  cpu: NodeJS.CpuUsage;
  loop: ReturnType<typeof performance.eventLoopUtilization>;
  totals: Record<Kind, { ms: number; n: number }>;
  paths: Map<string, { n: number; ms: number }>;
}

export function mark(): Mark {
  const s = state();
  return {
    at: performance.now(),
    cpu: process.cpuUsage(),
    loop: performance.eventLoopUtilization(),
    totals: {
      service: s.service.read(),
      superuser: s.superuser.read(),
      db: s.db.read(),
      connect: s.connect.read(),
      request: s.request.read(),
    },
    paths: new Map([...s.paths].map(([k, v]) => [k, { ...v }])),
  };
}

const ms = (value: number) => String(Math.round(value));

let currentFile = "unknown";

export function report(name: string, from: Mark): void {
  const to = mark();
  const cpu = process.cpuUsage(from.cpu);
  const loop = performance.eventLoopUtilization(to.loop, from.loop);
  const kinds = KINDS.map((k) => {
    const n = to.totals[k].n - from.totals[k].n;
    return `${k}=${ms(to.totals[k].ms - from.totals[k].ms)}ms/${n}`;
  });
  const paths = [...to.paths]
    .map(([k, v]) => {
      const before = from.paths.get(k) ?? { n: 0, ms: 0 };
      return { k, n: v.n - before.n, ms: v.ms - before.ms };
    })
    .filter((p) => p.n > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 6)
    .map((p) => `${p.k}:${p.n}:${ms(p.ms)}`)
    .join(",");
  const fields = [
    `wall=${ms(to.at - from.at)}`,
    `cpu=${ms((cpu.user + cpu.system) / 1000)}`,
    `loopActive=${ms(loop.active)}`,
    ...kinds,
    `paths=${paths}`,
  ];
  // biome-ignore lint/suspicious/noConsole: measurement only, one line per test for the db log
  console.log(`F3SPLIT ${currentFile} > ${name} | ${fields.join(" ")}`);
}

beforeAll((_context, suite) => {
  currentFile = suite.fullName;
});

let started: Mark | null = null;

beforeEach(() => {
  started = mark();
});

afterEach((context) => {
  if (started === null) return;
  const full = context.task.fullName;
  const prefix = `${context.task.file.fullName} > `;
  report(full.startsWith(prefix) ? full.slice(prefix.length) : full, started);
  started = null;
});
