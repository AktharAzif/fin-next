// MEASUREMENT ONLY, on a throwaway branch that is never merged (CI fix 3, the cause-first pass):
// times the staff harness's steps and prints one line per test with the step totals, and one for
// the file's setup. A key names the steps it runs inside (`enrolled#1/pendingSession/route`);
// `pg` is the time in node-postgres queries inside that step and `pg.connect` the time taking a
// pooled client (a new connection included). Steps that overlap add up, so under a race a key can
// exceed the wall time.
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { afterEach, beforeEach } from "vitest";
import { Browser, type StaffHarness } from "./harness.ts";

interface Entry {
  ms: number;
  n: number;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

const where = new AsyncLocalStorage<string>();
let bucket = new Map<string, Entry>();
let inTest = false;
let person = 0;
let started = performance.now();

function add(key: string, ms: number): void {
  const entry = bucket.get(key) ?? { ms: 0, n: 0 };
  entry.ms += ms;
  entry.n += 1;
  bucket.set(key, entry);
}

function keyFor(label: string): string {
  const parent = where.getStore();
  return parent === undefined ? label : `${parent}/${label}`;
}

export async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const key = keyFor(label);
  const start = performance.now();
  try {
    return await where.run(key, fn);
  } finally {
    add(key, performance.now() - start);
  }
}

function print(label: string): void {
  const total = Math.round(performance.now() - started);
  const parts: string[] = [];
  for (const [key, entry] of bucket) {
    const times = entry.n > 1 ? `x${entry.n}` : "";
    parts.push(`${key}=${Math.round(entry.ms)}${times}`);
  }
  // biome-ignore lint/suspicious/noConsole: a throwaway measurement line, never merged
  console.log(`TIMING staff ${label} | total=${total} ${parts.join(" ")}`);
  bucket = new Map();
}

function timedCall(key: string, run: () => unknown): unknown {
  const start = performance.now();
  const result = run();
  if (!(result instanceof Promise)) return result;
  return result.finally(() => add(key, performance.now() - start));
}

const clientProto = pg.Client.prototype as unknown as { query: Method };
const query = clientProto.query;
clientProto.query = function timedQuery(this: unknown, ...args: unknown[]) {
  if (typeof args.at(-1) === "function") return query.apply(this, args);
  return timedCall(keyFor("pg"), () => query.apply(this, args));
};

const poolProto = pg.Pool.prototype as unknown as { connect: Method };
const connect = poolProto.connect;
poolProto.connect = function timedConnect(this: unknown, ...args: unknown[]) {
  if (args.length > 0) return connect.apply(this, args);
  return timedCall(keyFor("pg.connect"), () => connect.apply(this, args));
};

const browserProto = Browser.prototype as unknown as { auth: Method };
const auth = browserProto.auth;
browserProto.auth = function timedAuth(this: unknown, ...args: unknown[]) {
  return timed(`auth:${String(args[1])}`, async () => auth.apply(this, args));
};

const STEPS = [
  "pendingSession",
  "seedMember",
  "issueCode",
  "latestCode",
  "route",
  "prove",
  "fixture",
  "events",
  "outbox",
];

/** Wraps the harness's steps; in the setup, `enrolled` is numbered per person. */
export function instrument(h: StaffHarness): void {
  const target = h as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of STEPS) {
    const original = target[name];
    if (original === undefined) continue;
    target[name] = (...args) => timed(name, () => original(...args));
  }
  const enrolled = target.enrolled;
  if (enrolled === undefined) return;
  target.enrolled = (...args) => {
    person += 1;
    return timed(inTest ? "enrolled" : `enrolled#${person}`, () => enrolled(...args));
  };
}

/** Call first in the file's beforeAll: the setup line counts from here. */
export function markSetup(): void {
  bucket = new Map();
  started = performance.now();
}

/** Registers the per-test lines; call at the top level of a test file. */
export function timeTests(file: string): void {
  beforeEach(() => {
    if (!inTest) print(`${file} [setup]`);
    inTest = true;
    bucket = new Map();
    started = performance.now();
  });
  afterEach((context) => {
    print(`${file} > ${context.task.name}`);
  });
}
