// Error reporting through the Sentry protocol to Better Stack Errors (ARCHITECTURE §10.5; spec 08
// §7.5; [OB-04]). A thin client on @sentry/core: one per process, no automatic instrumentation, no
// tracing, no context lines, `sendDefaultPii: false`, `release` and `environment` set, and every
// event and breadcrumb through Fin's scrubbers. `reportError` returns the errorId and writes
// `error.unexpected` with safeError's fields only. Errors never go to the console.
import { isFinError, safeError, scrubBreadcrumb, scrubEvent } from "@fin/core";
import {
  type BaseTransportOptions,
  createStackParser,
  createTransport,
  type ErrorEvent,
  Scope,
} from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";
import type { ServiceName } from "./config/index.ts";
import type { Telemetry } from "./telemetry/telemetry.ts";

export interface ReportIds {
  requestId?: string;
  runId?: string;
  route?: string;
  job?: string;
  orgId?: string;
  keyId?: string;
  userId?: string;
  staffId?: string;
  provider?: string;
}

export interface ReporterOptions {
  /** Absent in development and CI without an Errors application: lines only. */
  dsn: string | undefined;
  release: string;
  environment: string;
  service: ServiceName;
  telemetry: Telemetry;
  fetch?: typeof fetch;
  sendTimeoutMs?: number;
}

const ID_TAGS = [
  "requestId",
  "runId",
  "route",
  "job",
  "orgId",
  "keyId",
  "userId",
  "staffId",
  "provider",
] as const;

export class Reporter {
  private readonly client: ServerRuntimeClient | undefined;
  private readonly telemetry: Telemetry;
  private readonly service: ServiceName;

  constructor(options: ReporterOptions) {
    this.telemetry = options.telemetry;
    this.service = options.service;
    if (options.dsn === undefined) return;
    const send = options.fetch ?? fetch;
    const timeoutMs = options.sendTimeoutMs ?? 3000;
    const makeTransport = (transportOptions: BaseTransportOptions) =>
      createTransport(transportOptions, async (request) => {
        const response = await send(transportOptions.url, {
          method: "POST",
          headers: { "content-type": "application/x-sentry-envelope" },
          body: request.body as string | Uint8Array<ArrayBuffer>,
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
        await response.body?.cancel();
        return {
          statusCode: response.status,
          headers: {
            "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
            "retry-after": response.headers.get("retry-after"),
          },
        };
      });
    this.client = new ServerRuntimeClient({
      dsn: options.dsn,
      release: options.release,
      environment: options.environment,
      transport: makeTransport,
      stackParser: createStackParser(nodeStackLineParser()),
      integrations: [],
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      attachStacktrace: false,
      sendClientReports: false,
      tracePropagationTargets: [],
      platform: "node",
      runtime: { name: "node", version: process.version },
      beforeSend: (event: ErrorEvent) => scrubEvent(event),
      beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
    });
    this.client.init();
  }

  /** Whether events leave the process. */
  get sending(): boolean {
    return this.client !== undefined;
  }

  /** Reports an unexpected error; returns its errorId and writes `error.unexpected`. */
  reportError(error: unknown, ids: ReportIds = {}): string {
    const unit = this.telemetry.currentUnit();
    const merged: ReportIds = { ...unit, ...ids };
    let errorId: string = crypto.randomUUID().replaceAll("-", "");
    if (this.client !== undefined) {
      try {
        const scope = new Scope();
        const tags: Record<string, string> = {
          service: this.service,
          fin_fixed_message: isFinError(error) ? "true" : "false",
        };
        for (const key of ID_TAGS) {
          const value = merged[key];
          if (value !== undefined) tags[key] = value;
        }
        scope.setTags(tags);
        errorId = this.client.captureException(error, { originalException: error }, scope);
      } catch {
        // Reporting never breaks the work; the line below still records the error.
      }
    }
    const safe = safeError(error);
    const fields: Record<string, unknown> = {
      errorId,
      errorName: safe.errorName,
      errorCode: safe.errorCode,
      frames: safe.frames.slice(0, 5),
    };
    if (merged.route !== undefined) fields.route = merged.route;
    if (merged.job !== undefined) fields.job = merged.job;
    this.telemetry.log("error.unexpected", fields, "error");
    return errorId;
  }

  /** Waits for queued events, for at most `timeoutMs`. */
  async flush(timeoutMs: number): Promise<boolean> {
    if (this.client === undefined) return true;
    try {
      return await this.client.flush(timeoutMs);
    } catch {
      return false;
    }
  }
}
