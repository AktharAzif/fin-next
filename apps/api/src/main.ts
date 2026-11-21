// `api` (spec 01 §4.5, §6.2): the private service behind every door. Phase 0's skeleton answers
// `/healthz` and `/readyz` to private callers and refuses everything else as an outside request
// (doors/outside.ts). The same image runs its other services from Railway's start command (spec 01
// §6.2, §6.6): `worker` with `--worker` (worker/main.ts), and `migrate` with `--migrate`,
// `--bootstrap`, `--print-db-cert` or `--task <name>` (migrate/main.ts, whose CLI defines them). Any
// other start command exits 64 with a `process.mode_refused` line that names only the mode, never an
// argument, so a service never runs the wrong mode silently.
import { type Clock, rfc3339, systemClock } from "@fin/core";
import {
  type BuiltService,
  type Env,
  type RunningService,
  type RunOptions,
  runService,
  type ServiceContext,
  type ServiceDefinition,
} from "@fin/server";
import { loadDocsOrigin } from "@fin/server/config";
import { privateHealth } from "@fin/server/health";
import {
  apiHeaders,
  errorHandler,
  type FinEnv,
  notFoundHandler,
  type RequestOptions,
  requestUnit,
} from "@fin/server/http";
import { Hono } from "hono";
import { dropEdgeHeaders, outsideRequest } from "./doors/outside.ts";
import { EXIT_USAGE, parseArgs, runMigrateCli, UsageError } from "./migrate/main.ts";
import { workerService } from "./worker/main.ts";

export function buildApi(ctx: ServiceContext): BuiltService {
  const options: RequestOptions = {
    telemetry: ctx.telemetry,
    reporter: ctx.reporter,
    clock: ctx.clock,
    docsOrigin: loadDocsOrigin(ctx.env, ctx.config.environment),
  };
  const app = new Hono<FinEnv>();
  app.onError(errorHandler(options));
  app.notFound(notFoundHandler(options));
  app.use(requestUnit(options));
  app.use(
    apiHeaders({
      release: ctx.config.release,
      environment: ctx.config.environment,
      defaultRole: "private",
    }),
  );
  app.use(dropEdgeHeaders());
  app.use(privateHealth({ readiness: ctx.readiness, notFound: notFoundHandler(options) }));
  app.all("*", outsideRequest(options));
  return { fetch: app.fetch };
}

export const apiService: ServiceDefinition = { services: ["api"], build: buildApi };

/** The start commands the image takes (spec 01 §6.2, §6.6); with no flag it runs `api`. */
export const USAGE =
  "dist/main.js [--worker | --migrate | --bootstrap | --print-db-cert | --task <name>]";

/** The flags that start `migrate`; what may follow each is its CLI's rule (migrate/main.ts). */
export const MIGRATE_FLAGS: readonly string[] = [
  "--migrate",
  "--bootstrap",
  "--print-db-cert",
  "--task",
];

export type Entry = "api" | "worker" | "migrate";

/** The entry a start command runs, or, when it is refused, the mode it names (never an argument). */
export type Selection = { entry: Entry } | { refused: string };

export function selectEntry(argv: readonly string[]): Selection {
  const flag = argv[0];
  if (flag === undefined) return { entry: "api" };
  if (flag === "--worker") return argv.length === 1 ? { entry: "worker" } : { refused: "worker" };
  if (MIGRATE_FLAGS.includes(flag)) {
    try {
      parseArgs(argv);
      return { entry: "migrate" };
    } catch (error) {
      if (error instanceof UsageError) return { refused: flag.slice(2) };
      throw error;
    }
  }
  return { refused: "unknown" };
}

export interface ApiMainOptions {
  /** Ends the process after a `migrate` run or a refusal. */
  exit?: (code: number) => void;
  /** Writes text as given, each line ending in a newline: the refusal line and `migrate`'s output. */
  write?: (text: string) => void;
  /** `migrate`'s environment (process.env by default). */
  env?: Env;
  /** The clock of `migrate` and of the refusal line (the system clock by default). */
  clock?: Clock;
  /** runService's options for `api` and `worker` (tests listen on port 0 and keep the lines). */
  run?: RunOptions;
}

export async function main(
  argv: readonly string[],
  options: ApiMainOptions = {},
): Promise<RunningService | undefined> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  const clock = options.clock ?? systemClock;
  const selected = selectEntry(argv);
  if ("refused" in selected) {
    write(
      `${JSON.stringify({
        dt: rfc3339(clock.now()),
        message: "process.mode_refused",
        event: "process.mode_refused",
        level: "error",
        mode: selected.refused,
        usage: USAGE,
      })}\n`,
    );
    exit(EXIT_USAGE);
    return undefined;
  }
  if (selected.entry === "api") return runService(apiService, options.run);
  if (selected.entry === "worker") return runService(workerService, options.run);
  exit(await runMigrateCli(argv, options.env ?? process.env, { stdout: write, clock }));
  return undefined;
}
