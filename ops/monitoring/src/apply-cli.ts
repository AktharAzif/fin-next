// ops/monitoring's own entry point for `pnpm fin monitoring apply <env>`. pnpm fin (ops/fin's
// monitoring/apply.ts) runs this file as a child process with an IPC channel, since ops/fin may not
// import ops/monitoring (CI-14). It takes no argument and no environment: everything comes over the
// channel, and nothing private is ever in its argv or its environment.
//
// pnpm fin keeps what is its own: the overlay, the team tokens (read from the operator's
// FIN_BETTERSTACK_*_TOKEN_FILE files by pnpm fin's credential handling), the run lock and the run
// log. So this process holds no token. Every Better Stack call it makes is a `fetch` message that
// pnpm fin checks (Better Stack's hosts only; no write in a dry run, before the run is registered
// or after a stop; every write named first), sends with the right team token, and answers with the
// status and body. The protocol, one JSON message at a time:
//
//   here -> pnpm fin   ready     first, once this process listens (Node drops a message that
//                                arrives before anything listens, so pnpm fin waits for it)
//   pnpm fin -> here   start     the environment, the arguments, the repository root, the hosts by
//                                role and the zones, the overlay's thresholds and grace periods,
//                                the monitor header (a real run only) and the time
//                      response  the answer to one fetch: its status and body, or an error
//                      ack       the answer to register: done, or why not
//   here -> pnpm fin   out       one line of output (masked here too; pnpm fin masks it again)
//                      fetch     one Better Stack call: method, URL, JSON body
//                      register  once, before the first write: the plan's counts (run.registered)
//                      change    a write is about to be made: op, kind, name (the run's in-flight)
//                      changed   that write ended, and whether it was made
//                      result    the run's result (counts, outcome, read-back), then the channel
//                                closes
//                      error     the run threw: the error's name and its masked message
//
// Run any other way (without the channel), it refuses and exits 64. When the channel closes before
// the run ends (pnpm fin was stopped or killed), it exits 70 at once: without pnpm fin it can send
// nothing.

import {
  type ApplyResult,
  hostMask,
  type MonitoringContext,
  monitoringApply,
  type PlanCounts,
  type WriteChange,
} from "./apply.ts";
import type { Fetch } from "./betterstack.ts";

/** What pnpm fin sends first. */
export interface StartMessage {
  readonly t: "start";
  readonly env: string;
  readonly args: readonly string[];
  readonly root: string;
  readonly hosts: Readonly<Record<string, string>>;
  readonly zones: readonly string[];
  readonly thresholds: Readonly<Record<string, number>>;
  readonly grace: Readonly<Record<string, number>>;
  readonly monitorHeader?: string;
  /** The run's time, from pnpm fin's clock (a pause's reason carries its date). */
  readonly now: string;
}

/** A message this process sends. */
export type ChildMessage =
  | { readonly t: "ready" }
  | { readonly t: "out"; readonly text: string }
  | {
      readonly t: "fetch";
      readonly id: number;
      readonly method: string;
      readonly url: string;
      readonly body?: string;
    }
  | { readonly t: "register"; readonly id: number; readonly plan: PlanCounts }
  | ({ readonly t: "change" } & WriteChange)
  | ({ readonly t: "changed"; readonly ok: boolean } & WriteChange)
  | { readonly t: "result"; readonly result: ApplyResult }
  | { readonly t: "error"; readonly name: string; readonly message: string };

/** The channel to pnpm fin: process.send, or a test's stand-in. */
export interface Channel {
  send(message: ChildMessage): void;
  /** Calls `listener` with each message pnpm fin sends. */
  onMessage(listener: (message: unknown) => void): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const numbers = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n));
const strings = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((s) => typeof s === "string");

/** The start message, checked, or undefined when it is not one. */
export function parseStart(message: unknown): StartMessage | undefined {
  if (!isRecord(message) || message.t !== "start") return undefined;
  const { env, args, root, hosts, zones, thresholds, grace, monitorHeader, now } = message;
  if (typeof env !== "string" || typeof root !== "string" || typeof now !== "string") {
    return undefined;
  }
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return undefined;
  if (!Array.isArray(zones) || !zones.every((z) => typeof z === "string")) return undefined;
  if (!strings(hosts) || !numbers(thresholds) || !numbers(grace)) return undefined;
  if (monitorHeader !== undefined && typeof monitorHeader !== "string") return undefined;
  if (Number.isNaN(Date.parse(now))) return undefined;
  return {
    t: "start",
    env,
    args,
    root,
    hosts,
    zones,
    thresholds,
    grace,
    ...(monitorHeader === undefined ? {} : { monitorHeader }),
    now,
  };
}

/** A status whose response has no body. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * Runs one apply over the channel: waits for the start message, runs monitoringApply with a fetch
 * and hooks that go through pnpm fin, and sends the result (or the error). Resolves with the exit
 * code this process should end with.
 */
export function runOverChannel(channel: Channel): Promise<number> {
  const fetches = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void }>();
  const acks = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  let next = 1;
  let started = false;
  const done = Promise.withResolvers<number>();

  const fetchVia: Fetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const id = next++;
      fetches.set(id, { resolve, reject });
      const body = init?.body;
      channel.send({
        t: "fetch",
        id,
        method: init?.method ?? "GET",
        url: input,
        ...(typeof body === "string" ? { body } : {}),
      });
    });

  const register = (plan: PlanCounts) =>
    new Promise<void>((resolve, reject) => {
      const id = next++;
      acks.set(id, { resolve, reject });
      channel.send({ t: "register", id, plan });
    });

  const answer = (message: Record<string, unknown>) => {
    const id = typeof message.id === "number" ? message.id : -1;
    if (message.t === "response") {
      const waiting = fetches.get(id);
      if (waiting === undefined) return;
      fetches.delete(id);
      if (typeof message.error === "string" || typeof message.status !== "number") {
        // The client keeps none of this text: it says only that the call got no answer.
        const error = new Error("pnpm fin did not send this call");
        if (message.error === "timed out") error.name = "TimeoutError";
        waiting.reject(error);
        return;
      }
      const status = message.status;
      const body = typeof message.body === "string" ? message.body : "";
      waiting.resolve(new Response(NULL_BODY.has(status) ? null : body, { status }));
    } else if (message.t === "ack") {
      const waiting = acks.get(id);
      if (waiting === undefined) return;
      acks.delete(id);
      if (typeof message.error === "string") waiting.reject(new Error(message.error));
      else waiting.resolve();
    }
  };

  const start = async (s: StartMessage) => {
    const mask = hostMask(
      s.hosts,
      s.zones,
      s.monitorHeader === undefined ? [] : [{ value: s.monitorHeader, as: "(the monitor header)" }],
    );
    const ctx: MonitoringContext = {
      env: s.env,
      args: s.args,
      root: s.root,
      hosts: s.hosts,
      zones: s.zones,
      thresholds: s.thresholds,
      grace: s.grace,
      // No token file and no other variable: pnpm fin holds them.
      environ: {},
      fetchAuthenticates: true,
      ...(s.monitorHeader === undefined ? {} : { monitorHeader: s.monitorHeader }),
      stdout: { write: (text) => channel.send({ t: "out", text }) },
      fetch: fetchVia,
      now: () => new Date(s.now),
      hooks: {
        beforeWrites: register,
        async writing<T>(change: WriteChange, send: () => Promise<T>): Promise<T> {
          channel.send({ t: "change", ...change });
          let ok = false;
          try {
            const sent = await send();
            ok = true;
            return sent;
          } finally {
            channel.send({ t: "changed", ...change, ok });
          }
        },
      },
    };
    try {
      const result = await monitoringApply(ctx);
      channel.send({ t: "result", result });
      done.resolve(0);
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      const message = error instanceof Error ? mask(error.message) : "";
      channel.send({ t: "error", name, message });
      done.resolve(1);
    }
  };

  channel.onMessage((message) => {
    if (!isRecord(message)) return;
    if (message.t === "start") {
      const s = parseStart(message);
      if (started) return;
      started = true;
      if (s === undefined) {
        channel.send({ t: "error", name: "UsageError", message: "the start message is malformed" });
        done.resolve(64);
        return;
      }
      void start(s);
      return;
    }
    answer(message);
  });
  // Only now does anything listen: pnpm fin sends the start message once it hears this.
  channel.send({ t: "ready" });
  return done.promise;
}

async function main(): Promise<void> {
  const send = process.send?.bind(process);
  if (send === undefined) {
    process.stderr.write(
      "apply-cli.ts runs only under pnpm fin monitoring apply <env>, which holds the tokens, the overlay and the run\n",
    );
    process.exitCode = 64;
    return;
  }
  let finished = false;
  // Without pnpm fin nothing can be sent: a channel that closes before the end ends the process.
  process.on("disconnect", () => {
    if (!finished) process.exit(70);
  });
  // Messages are written in order, so the last one written means every one before it was too.
  let written: Promise<void> = Promise.resolve();
  const code = await runOverChannel({
    send: (message) => {
      written = new Promise((resolve) => {
        send(message, () => resolve());
      });
    },
    onMessage: (listener) => {
      process.on("message", listener);
    },
  });
  finished = true;
  process.exitCode = code;
  // Closing the channel only once the result has been written lets the process end.
  await written;
  process.disconnect?.();
}

if (import.meta.main) await main();
