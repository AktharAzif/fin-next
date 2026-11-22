// `pnpm fin monitoring apply <env> [--dry-run] [--confirm-delete <count>] [--assert-empty-team
// <team>] [--split-sources] [--redeliver]` (spec 08 §7.11, spec 01 §8; OB-05, OB-16): applies
// ops/monitoring/<env>/ to Better Stack, the dry-run difference printed first.
//
// The apply is ops/monitoring's own code, and ops/fin imports only Node's built-ins and the control
// paths (CI-14). So pnpm fin runs ops/monitoring's entry point, ops/monitoring/src/apply-cli.ts, as
// a child process (Runtime.node: no argument, an empty environment, an IPC channel), and keeps
// everything that is its own:
//   - the credentials. The team tokens (ops/credentials.json's betterstack-team-tokens:
//     FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE and FIN_BETTERSTACK_UPTIME_TOKEN_FILE) are read by
//     pnpm fin's credential handling and never leave this process but in the requests that carry
//     them: the child holds no token. The monitor header (FIN_MONITOR_HEADER_FILE, needed by a real
//     run; a dry run without it does not compare it) is read the same way and handed to the child
//     over the channel, since it is part of what the monitors send. Nothing private is ever in the
//     child's argv or environment: the overlay's hosts, zone, thresholds and grace periods go over
//     the channel too.
//   - the calls. Each Better Stack call the child makes comes here as a message. It is sent only to
//     Better Stack's three API hosts, with that product's team token; a write never in a dry run,
//     only inside the registered run (Run.assertCanStart: registered, still holding the lock, not
//     stopped), only once the child has named it (marked in flight while it is sent), and never
//     after a stop or after any refusal of pnpm fin's own, a write whose run.step could not be
//     recorded among them (the run then ends failed with that error's code, as applyPlan's does).
//     Whatever is refused gets no answer, so the child stops.
//   - the run. cli.ts takes the lock before the child starts; run.registered (with the plan's
//     counts) is written and shipped when the child asks, after its plan has passed every rule and
//     before its first write; each write it made is a run.step; run.done records the counts and the
//     read-back. A dry run, a refused plan and a plan with nothing to change register nothing.
//   - the output. Every line the child prints, and anything on its standard output or error, goes
//     through this process's masker (the overlay, the credentials, and every ingest token, ingest
//     host, heartbeat URL and long ID Better Stack answers with) before it is printed.
//   - the result. The exit code follows pnpm fin's table (docs/runbooks/pnpm-fin.md), and the run
//     writes one `monitoring.apply` line, names and counts only.

import { join } from "node:path";
import type { Command } from "../command.ts";
import { flagBool, flagInt, flagString } from "../core/args.ts";
import { type Context, messageOf } from "../core/context.ts";
import { hasCredential } from "../core/credentials.ts";
import { ConfigError, EXIT, type ExitCode, FinError, UsageError } from "../core/errors.ts";
import type { InFlight } from "../core/run.ts";
import type { NodeChild, NodeExit } from "../core/runtime.ts";
import type { Secret } from "../core/secret.ts";

/** Better Stack's API hosts and the team token each takes (the Telemetry token serves Errors). */
const API_ORIGINS: Readonly<Record<string, "telemetry" | "uptime">> = {
  "https://telemetry.betterstack.com": "telemetry",
  "https://errors.betterstack.com": "telemetry",
  "https://incidents.betterstack.com": "uptime",
};
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "PATCH", "DELETE"]);
const WRITE_OPS: ReadonlySet<string> = new Set(["create", "update", "delete", "pause"]);
/** How long one Better Stack call may take. */
export const CALL_TIMEOUT_MS = 20_000;
/** The longest message the child may send (a JSON body of one object, or one line of output). */
const MAX_MESSAGE_TEXT = 1_000_000;

/** What the child's run ended with (ops/monitoring's ApplyResult), as far as pnpm fin reads it. */
export interface ChildResult {
  outcome: "dry-run" | "unchanged" | "applied" | "refused" | "stopped" | "mismatch";
  dryRun: boolean;
  drift: boolean;
  created: number;
  updated: number;
  deleted: number;
  paused: number;
  delivered: number;
  undelivered: string[];
  refusals: number;
  readBack?: { compared: number; mismatched: string[] };
}

const OUTCOMES: ReadonlySet<string> = new Set([
  "dry-run",
  "unchanged",
  "applied",
  "refused",
  "stopped",
  "mismatch",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
const names = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/** The child's result, read field by field; undefined when it is not one. */
export function parseResult(value: unknown): ChildResult | undefined {
  if (!isRecord(value) || typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome)) {
    return undefined;
  }
  const readBack = isRecord(value.readBack)
    ? { compared: count(value.readBack.compared), mismatched: names(value.readBack.mismatched) }
    : undefined;
  return {
    outcome: value.outcome as ChildResult["outcome"],
    dryRun: value.dryRun === true,
    drift: value.drift === true,
    created: count(value.created),
    updated: count(value.updated),
    deleted: count(value.deleted),
    paused: count(value.paused),
    delivered: count(value.delivered),
    undelivered: names(value.undelivered),
    refusals: count(value.refusals),
    ...(readBack === undefined ? {} : { readBack }),
  };
}

/** The exit code of a result (pnpm fin's table). */
export function exitOf(result: ChildResult): ExitCode {
  switch (result.outcome) {
    case "dry-run":
      return result.drift ? EXIT.drift : EXIT.ok;
    case "unchanged":
    case "applied":
      return EXIT.ok;
    case "refused":
      return EXIT.refused;
    case "stopped":
      return EXIT.unavailable;
    case "mismatch":
      return EXIT.drift;
  }
}

interface Ended {
  exit: NodeExit;
  result: ChildResult | undefined;
  /** What the child threw, its name and masked message. */
  error: { name: string; message: string } | undefined;
  /** The first of pnpm fin's own refusals (the registration, a write it would not send). */
  refusal: unknown;
}

/** One child run: the channel's other end. */
class ApplySession {
  readonly #ctx: Context;
  readonly #tokens: Readonly<Record<"telemetry" | "uptime", Secret>>;
  #child: NodeChild | undefined;
  /** The start message, until the child is ready for it. */
  #start: Record<string, unknown> | undefined;
  /** The write the child has named and not yet ended. */
  #current: InFlight | undefined;
  readonly #pending = new Set<Promise<void>>();
  #result: ChildResult | undefined;
  #error: { name: string; message: string } | undefined;
  #refusal: unknown;
  readonly #refusalsPrinted = new Set<string>();
  readonly #partial = { stdout: "", stderr: "" };

  constructor(ctx: Context, tokens: Readonly<Record<"telemetry" | "uptime", Secret>>) {
    this.#ctx = ctx;
    this.#tokens = tokens;
  }

  /**
   * Runs the child to its end. The start message goes once the child says it is ready (Node drops
   * a message that reaches a process before anything there listens).
   */
  async run(script: string, start: Record<string, unknown>): Promise<Ended> {
    this.#start = start;
    const child = this.#ctx.runtime.node(script, {
      message: (message) => this.#onMessage(message),
      output: (stream, text) => this.#onOutput(stream, text),
    });
    this.#child = child;
    const exit = await child.exited;
    if (this.#start !== undefined) {
      this.#error ??= { name: "Error", message: "the apply process ended before it was ready" };
    }
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
    for (const stream of ["stdout", "stderr"] as const) this.#onOutput(stream, "\n");
    return { exit, result: this.#result, error: this.#error, refusal: this.#refusal };
  }

  /**
   * Keeps a message's work until it ends. A fault in it is pnpm fin's own: it is kept as the run's
   * refusal, so nothing more is sent and the run ends failed with its code, and the child, which
   * may be waiting for an answer that will not come, is ended.
   */
  #track(work: Promise<void>): void {
    const tracked = work
      .catch((error: unknown) => {
        this.#refusal ??= error;
        this.#child?.kill();
      })
      .finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  #send(message: Record<string, unknown>): void {
    this.#child?.send(message);
  }

  /** Text the child should not write: masked, a line at a time, as a warning. */
  #onOutput(stream: "stdout" | "stderr", text: string): void {
    const lines = (this.#partial[stream] + text).split("\n");
    this.#partial[stream] = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim() !== "") this.#ctx.out.warn(`the apply process's ${stream}: ${line}`);
    }
  }

  #onMessage(message: unknown): void {
    if (!isRecord(message)) return;
    switch (message.t) {
      case "ready": {
        const start = this.#start;
        this.#start = undefined;
        if (start !== undefined && this.#child?.send(start) !== true) {
          this.#error = { name: "Error", message: "the apply process could not be started" };
          this.#child?.kill();
        }
        return;
      }
      case "out":
        if (typeof message.text === "string" && message.text.length <= MAX_MESSAGE_TEXT) {
          for (const line of message.text.replace(/\n$/, "").split("\n")) this.#ctx.out.info(line);
        }
        return;
      case "fetch":
        this.#track(this.#forward(message));
        return;
      case "register":
        this.#track(this.#register(message));
        return;
      case "change":
        this.#change(message);
        return;
      case "changed":
        this.#changed(message);
        return;
      case "result":
        this.#result = parseResult(message.result);
        if (this.#result === undefined) {
          this.#error = { name: "Error", message: "the apply process sent a malformed result" };
        }
        return;
      case "error":
        this.#error = {
          name: typeof message.name === "string" ? message.name : "Error",
          message: typeof message.message === "string" ? message.message : "",
        };
        return;
      default:
        return;
    }
  }

  /** Keeps the first of pnpm fin's refusals, and says each kind once. */
  #refuse(why: string, error?: unknown): void {
    this.#refusal ??= error ?? new FinError(why, EXIT.refused);
    if (this.#refusalsPrinted.has(why)) return;
    this.#refusalsPrinted.add(why);
    this.#ctx.out.error(`monitoring apply: pnpm fin did not send a call: ${why}`);
  }

  async #register(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    const plan = isRecord(message.plan) ? message.plan : {};
    const counts = Object.fromEntries(
      ["create", "update", "delete", "pause", "manual", "unchanged"].map((k) => [
        k,
        count(plan[k]),
      ]),
    );
    try {
      if (this.#ctx.dryRun) throw new FinError("a dry run registers no run", EXIT.internal);
      if (this.#refusal !== undefined)
        throw new FinError("an earlier call was refused", EXIT.refused);
      this.#ctx.run.register({ plan: counts });
      await this.#ctx.run.flushLines();
      this.#send({ t: "ack", id });
    } catch (error) {
      this.#refusal ??= error;
      this.#send({ t: "ack", id, error: this.#ctx.masker.mask(messageOf(error)) });
    }
  }

  #change(message: Record<string, unknown>): void {
    const { op, kind, key } = message;
    if (typeof op !== "string" || !WRITE_OPS.has(op)) return;
    if (typeof kind !== "string" || typeof key !== "string") return;
    this.#current = { kind, name: key, action: op };
  }

  /** The named write has ended (its run.step was written when Better Stack answered it). */
  #changed(message: Record<string, unknown>): void {
    const current = this.#current;
    if (current !== undefined && message.kind === current.kind && message.key === current.name) {
      this.#current = undefined;
    }
  }

  /** Checks one call the child asks for, sends it with its team token, and answers. */
  async #forward(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    const answer = (fields: Record<string, unknown>) =>
      this.#send({ t: "response", id, ...fields });
    const refuse = (why: string, error?: unknown) => {
      this.#refuse(why, error);
      answer({ error: "refused" });
    };
    const method = message.method;
    const body = message.body;
    if (typeof method !== "string" || !METHODS.has(method))
      return refuse("a method other than GET, POST, PATCH or DELETE");
    if (typeof message.url !== "string" || message.url.length > 2048)
      return refuse("a malformed URL");
    let url: URL;
    try {
      url = new URL(message.url);
    } catch {
      return refuse("a malformed URL");
    }
    const product = Object.hasOwn(API_ORIGINS, url.origin) ? API_ORIGINS[url.origin] : undefined;
    if (product === undefined || url.username !== "" || url.password !== "") {
      return refuse("a call to a host other than Better Stack's APIs");
    }
    if (body !== undefined) {
      if (typeof body !== "string" || body.length > MAX_MESSAGE_TEXT)
        return refuse("a malformed body");
      try {
        JSON.parse(body);
      } catch {
        return refuse("a body that is not JSON");
      }
      if (method === "GET" || method === "DELETE") return refuse(`a ${method} with a body`);
    }
    const run = this.#ctx.run;
    if (run.stopped !== undefined) return refuse("the run was stopped");
    const send = () => this.#call(product, method, url.href, body as string | undefined);
    if (method === "GET") {
      answer(await send());
      return;
    }
    if (this.#ctx.dryRun) return refuse("a write in a dry run");
    // Once pnpm fin has refused anything (a record it could not write among them), nothing more
    // is written, as applyPlan stops at the change whose record failed.
    if (this.#refusal !== undefined) return refuse("an earlier call was refused");
    const change = this.#current;
    if (change === undefined) return refuse("a write the apply did not name first");
    try {
      run.assertCanStart(`${change.action} ${change.kind}`);
    } catch (error) {
      return refuse(error instanceof FinError ? error.message : "the run cannot send", error);
    }
    let answered: Record<string, unknown> = { error: "no answer" };
    await run.sending(change, async () => {
      answered = await send();
    });
    // Recorded once Better Stack has made it, before the child hears of it, whatever the child
    // does next (it may have been stopped meanwhile), as applyPlan records the change in flight
    // that settles. A record that cannot be written refuses every later write.
    const status = answered.status;
    if (typeof status === "number" && status >= 200 && status < 300) {
      try {
        run.step(change.kind, change.name, change.action);
      } catch (error) {
        this.#refusal ??= error;
        this.#ctx.out.error(
          `monitoring apply: Better Stack made ${change.action} ${change.kind} ${change.name}, but its run.step could not be recorded (${this.#ctx.masker.mask(messageOf(error))}); nothing more is sent`,
        );
      }
    }
    // The child is told what Better Stack did either way: an object it made has secrets to deliver.
    answer(answered);
  }

  async #call(
    product: "telemetry" | "uptime",
    method: string,
    url: string,
    body: string | undefined,
  ): Promise<Record<string, unknown>> {
    let status: number;
    let text: string;
    try {
      const response = await this.#ctx.runtime.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.#tokens[product].reveal()}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      const timedOut = isRecord(error) && error.name === "TimeoutError";
      return { error: timedOut ? "timed out" : "no answer" };
    }
    this.#learn(text);
    return { status, body: text };
  }

  /**
   * Registers what Better Stack answers with that must never be printed: each object's ID (a long
   * one; the masker leaves short numbers alone), and each ingest token, ingest host and heartbeat
   * URL. The child prints none of them; this holds if it ever did.
   */
  #learn(text: string): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(json)) return;
    const items = Array.isArray(json.data) ? json.data : [json.data];
    const masker = this.#ctx.masker;
    for (const item of items) {
      if (!isRecord(item)) continue;
      if (typeof item.id === "string" || typeof item.id === "number") {
        masker.register(String(item.id), "<betterstack-id>");
      }
      const a = isRecord(item.attributes) ? item.attributes : {};
      if (typeof a.token === "string") masker.register(a.token, "<betterstack-ingest-token>");
      if (typeof a.ingesting_host === "string") {
        masker.register(a.ingesting_host, "<betterstack-ingest-host>");
      }
      // A monitor's url is the checked page (its host is the overlay's); a heartbeat's is secret.
      if (typeof a.url === "string" && a.pronounceable_name === undefined) {
        masker.register(a.url, "<heartbeat-url>");
      }
    }
  }
}

/** The child's arguments, rebuilt from pnpm fin's parsed flags (they never carry a secret). */
function childArgs(ctx: Context): string[] {
  const confirm = flagInt(ctx.args, "confirm-delete");
  const team = flagString(ctx.args, "assert-empty-team");
  return [
    ...(ctx.dryRun ? ["--dry-run"] : []),
    ...(confirm === undefined ? [] : ["--confirm-delete", String(confirm)]),
    ...(team === undefined ? [] : ["--assert-empty-team", team]),
    ...(flagBool(ctx.args, "split-sources") ? ["--split-sources"] : []),
    ...(flagBool(ctx.args, "redeliver") ? ["--redeliver"] : []),
  ];
}

/** The one line a run writes: names and counts, never a value. */
function lineFields(result: ChildResult | undefined, dryRun: boolean): Record<string, unknown> {
  if (result === undefined) return { dryRun, outcome: "error" };
  return {
    dryRun,
    outcome: result.outcome,
    drift: result.drift,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    paused: result.paused,
    delivered: result.delivered,
    undelivered: result.undelivered.length,
    refusals: result.refusals,
    ...(result.readBack === undefined
      ? {}
      : {
          readBackCompared: result.readBack.compared,
          readBackMismatched: result.readBack.mismatched,
        }),
  };
}

function levelOf(result: ChildResult | undefined): "info" | "warn" | "error" {
  if (result === undefined) return "error";
  if (result.outcome === "stopped" || result.outcome === "mismatch") return "error";
  if (result.outcome === "refused" || result.drift) return "warn";
  return "info";
}

export const monitoringApply: Command = {
  words: ["monitoring", "apply"],
  summary: "apply ops/monitoring/<env>/ to Better Stack, the dry run's difference first",
  positionals: [],
  flags: [
    {
      name: "assert-empty-team",
      kind: "string",
      description: "the first apply only: the team (fin-<env>) holds nothing yet",
    },
    {
      name: "split-sources",
      kind: "boolean",
      description: "one exploration per source for an alert over several",
    },
    {
      name: "redeliver",
      kind: "boolean",
      description: "read the services' secrets from Better Stack again and deliver them",
    },
  ],
  overlay: true,
  mutating: true,
  runbook: "monitoring-drift.md",
  async run(ctx) {
    const team = flagString(ctx.args, "assert-empty-team");
    if (team !== undefined && team !== `fin-${ctx.environment}`) {
      throw new UsageError(
        `--assert-empty-team takes this environment's team, fin-${ctx.environment}`,
      );
    }
    const overlay = ctx.overlay;
    const telemetry = ctx.credential("FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE");
    const uptime = ctx.credential("FIN_BETTERSTACK_UPTIME_TOKEN_FILE");
    let header: Secret | undefined;
    if (hasCredential(ctx.runtime.env, "FIN_MONITOR_HEADER_FILE")) {
      header = ctx.credential("FIN_MONITOR_HEADER_FILE");
    } else if (!ctx.dryRun) {
      throw new ConfigError(
        "FIN_MONITOR_HEADER_FILE is not set: every monitor sends the secret header (a dry run without it does not compare it)",
      );
    }
    const reveal = (numbers: Overlay["thresholds"]) =>
      Object.fromEntries(Object.entries(numbers).map(([name, n]) => [name, n.reveal()]));
    const hosts = Object.fromEntries(
      Object.entries(overlay.hosts).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
    const start = {
      t: "start",
      env: ctx.environment,
      args: childArgs(ctx),
      root: ctx.runtime.repoRoot,
      hosts,
      zones: [overlay.zone],
      thresholds: reveal(overlay.thresholds),
      grace: reveal(overlay.grace),
      ...(header === undefined ? {} : { monitorHeader: header.reveal() }),
      now: ctx.runtime.now().toISOString(),
    };
    const script = join(ctx.runtime.repoRoot, "ops", "monitoring", "src", "apply-cli.ts");
    const session = new ApplySession(ctx, { telemetry, uptime });
    const ended = await session.run(script, start);
    return conclude(ctx, ended);
  },
};

type Overlay = Context["overlay"];

/** Records how the child's run ended (the line, run.done) and gives the exit code. */
function conclude(ctx: Context, ended: Ended): number {
  const { result, error, refusal } = ended;
  ctx.run.line("monitoring.apply", levelOf(result), lineFields(result, ctx.dryRun));
  const stopped = ctx.run.stopped;
  if (ctx.run.registered) {
    const fields: Record<string, unknown> =
      result === undefined
        ? {}
        : {
            applied: {
              created: result.created,
              updated: result.updated,
              deleted: result.deleted,
              paused: result.paused,
            },
            delivered: result.delivered,
            undelivered: result.undelivered,
            ...(result.readBack === undefined ? {} : { readBack: result.readBack }),
          };
    const ok =
      stopped === undefined &&
      refusal === undefined &&
      (result?.outcome === "applied" || result?.outcome === "unchanged");
    ctx.finishRun(ok ? "ok" : "failed", {
      ...fields,
      ...(ok ? {} : { error: failure(ended, stopped !== undefined) }),
    });
  }
  // A stop, and pnpm fin's own refusals (a lock another run took, a run log that does not verify),
  // keep their own exit codes.
  ctx.run.assertNotStopped();
  if (refusal !== undefined) throw refusal;
  if (result !== undefined) return exitOf(result);
  if (error?.name === "UsageError") throw new UsageError(error.message);
  throw new FinError(`monitoring apply: ${failure(ended, false)}`, EXIT.internal);
}

function failure({ exit, result, error }: Ended, stopped: boolean): string {
  if (stopped) return "the run was stopped";
  if (result !== undefined) return `the apply ended ${result.outcome}`;
  if (error !== undefined) return `the apply process failed: ${error.name}: ${error.message}`;
  const how = exit.signal !== null ? `by ${exit.signal}` : `with exit ${exit.code ?? "unknown"}`;
  return `the apply process ended ${how} without a result`;
}
