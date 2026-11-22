// `api` (spec 01 §4.5, §6.2): the private service behind every door. Phase 0's skeleton answers
// `/healthz` and `/readyz` to private callers and refuses everything else as an outside request
// (doors/outside.ts). The same image runs `worker` (`--worker`), `migrate` (`--migrate`, and
// `--task <name>`); those modes are P0-E's and L-SAT-05's, and until their entries are wired in here
// a start with one of their flags exits 64 with a `process.mode_unavailable` line, so a service
// never runs the wrong mode silently.
import { rfc3339, systemClock } from "@fin/core";
import {
  type BuiltService,
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

/** The modes the image's start command may name (spec 01 §6.2). */
export const MODES = ["--worker", "--migrate", "--task"] as const;

export interface ApiMainOptions {
  exit?: (code: number) => void;
  stdout?: (line: string) => void;
}

export async function main(argv: readonly string[], options: ApiMainOptions = {}): Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const write = options.stdout ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const flag = argv[0];
  if (flag === undefined) {
    await runService(apiService);
    return;
  }
  const mode = (MODES as readonly string[]).includes(flag) ? flag.slice(2) : "unknown";
  write(
    JSON.stringify({
      dt: rfc3339(systemClock.now()),
      message: "process.mode_unavailable",
      event: "process.mode_unavailable",
      level: "error",
      mode,
    }),
  );
  exit(64);
}
