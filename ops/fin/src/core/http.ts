// HTTP for the provider clients: fetch with a timeout, bounded retries and error messages that
// never carry a request's headers or body (where the token and the secrets travel).

import { ProviderError } from "./errors.ts";
import type { FetchFn } from "./runtime.ts";

export interface HttpOptions {
  fetch: FetchFn;
  sleep: (ms: number) => Promise<void>;
  /** Attempts in all, for a request that may be retried. */
  attempts?: number;
  timeoutMs?: number;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  body?: string | FormData;
  /** Whether a failed attempt may be repeated (true for reads; writes only on 429). */
  idempotent: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/** Sends a request. Network errors and retryable statuses are retried with a short backoff. */
export async function send(
  provider: string,
  request: HttpRequest,
  options: HttpOptions,
): Promise<HttpResponse> {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let lastError = "no answer";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        signal: controller.signal,
        redirect: "error",
      };
      if (request.body !== undefined) init.body = request.body;
      response = await options.fetch(request.url, init);
    } catch (error) {
      clearTimeout(timer);
      lastError =
        error instanceof Error && error.name === "AbortError" ? "timed out" : "network error";
      if (request.idempotent && attempt < attempts) {
        await options.sleep(500 * 2 ** (attempt - 1));
        continue;
      }
      throw new ProviderError(provider, `${provider} ${request.method}: ${lastError}`, 0);
    }
    const text = await response.text();
    clearTimeout(timer);
    const retryable =
      RETRY_STATUS.has(response.status) && (request.idempotent || response.status === 429);
    if (retryable && attempt < attempts) {
      const after = Number(response.headers.get("retry-after"));
      const wait =
        Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 500 * 2 ** (attempt - 1);
      await options.sleep(wait);
      continue;
    }
    return { status: response.status, headers: response.headers, text };
  }
  throw new ProviderError(provider, `${provider} ${request.method}: ${lastError}`, 0);
}

/** Parses a JSON body, or throws a ProviderError that says only that it was not JSON. */
export function parseJson(provider: string, response: HttpResponse): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    throw new ProviderError(
      provider,
      `${provider} answered ${response.status} with a body that is not JSON`,
      response.status,
    );
  }
}
