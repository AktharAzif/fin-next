// The auth library's endpoints through api() (spec 02 §7.4, §7.5; spec 06 §1.1's auth client glue).
// The library is reached with the same client every screen uses (`createApiClient`, X-Fin-App on
// every unsafe method, contracts checked both ways), with a fetch that adapts two of the library's
// habits:
//   - a body-less POST under /api/auth/ is sent as `{}` with a JSON content type, as the library's
//     endpoints read an object body (the origin gate allows JSON only);
//   - a ceremony call (a code, a passkey) carries `Fin-Step-Up-Intent` when it proves an intent, and
//     the library's own error body (`{ code, message }`, upper-case codes) comes back as a problem
//     document with that code, so the page can tell a wrong code from an expired one.
// Fin's own problem documents pass through untouched. Two clients come from here:
//   - `libraryApi(fin, router)`: with the frame's reactions (the step-up re-sent once, the gates,
//     the sign-in redirect), for the library calls that change a factor;
//   - `ceremonyApi(intentId)`: with no reactions, for code entry and the StepUp ceremony itself,
//     which must never open another step-up, and whose 401 means a wrong code, not a lost session.
import { PROBLEM_CONTENT_TYPE } from "@fin/app-contracts";
import {
  type Api,
  createApiClient,
  createReleaseWatch,
  type FinRuntime,
  frameApiHooks,
  reportBrowserError,
} from "@fin/frame";
import type { AnyRouter } from "@tanstack/react-router";

/** The header that names a proved intent (spec 02 §7.1). */
export const STEP_UP_HEADER = "Fin-Step-Up-Intent";

const LIBRARY_PREFIX = "/api/auth/";

function pathOf(input: RequestInfo | URL): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw, "https://fin.invalid").pathname;
  } catch {
    return raw;
  }
}

/** Marks a problem document the client made from the library's own error body. */
export const LIBRARY_PROBLEM_TYPE = "about:blank#library";

/**
 * The library's `{ code, message }` error answer as a problem document with the same status and
 * code. Anything else (Fin's problem documents, an empty or non-JSON body) is returned as it came.
 */
export async function liftLibraryError(response: Response): Promise<Response> {
  if (response.ok) return response;
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return response;
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (typeof body !== "object" || body === null) return response;
  const code = (body as Record<string, unknown>).code;
  if (typeof code !== "string" || code === "") return response;
  const message = (body as Record<string, unknown>).message;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", PROBLEM_CONTENT_TYPE);
  headers.delete("Content-Length");
  return new Response(
    JSON.stringify({
      type: LIBRARY_PROBLEM_TYPE,
      title: typeof message === "string" && message !== "" ? message : code,
      status: response.status,
      code,
    }),
    { status: response.status, statusText: response.statusText, headers },
  );
}

export interface LibraryFetchOptions {
  /** Sent as `Fin-Step-Up-Intent` on every request (a ceremony proving that intent). */
  intentId?: string | null;
  /** Lift the library's error bodies into problem documents (ceremony clients only). */
  lift: boolean;
  fetch?: typeof fetch;
}

export function libraryFetch(options: LibraryFetchOptions): typeof fetch {
  const base = options.fetch ?? ((input, init) => fetch(input, init));
  return async (input, init = {}) => {
    const library = pathOf(input).startsWith(LIBRARY_PREFIX);
    const headers = new Headers(init.headers);
    const method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    if (library && method !== "GET" && method !== "HEAD" && (body === undefined || body === null)) {
      body = "{}";
      headers.set("Content-Type", "application/json");
    }
    if (options.intentId !== undefined && options.intentId !== null) {
      headers.set(STEP_UP_HEADER, options.intentId);
    }
    const next: RequestInit = { ...init, headers };
    if (body !== undefined) next.body = body;
    const response = await base(input, next);
    return library && options.lift ? liftLibraryError(response) : response;
  };
}

/** A client with no reactions, for code entry and the StepUp ceremony (see the file's head). */
export function ceremonyApi(intentId: string | null = null, fetchImpl?: typeof fetch): Api {
  return createApiClient({
    app: "console",
    fetch: libraryFetch({
      intentId,
      lift: true,
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    }),
  }).api;
}

const hooked = new WeakMap<object, Api>();

/**
 * The client for the library calls that change a factor: the frame's own reactions, so a
 * `403 step_up_required` opens the root StepUp dialog and the call is re-sent once with the intent.
 */
export function libraryApi<V>(fin: FinRuntime<V>, router: AnyRouter): Api {
  const known = hooked.get(fin);
  if (known !== undefined) return known;
  const client = createApiClient({ app: "console", fetch: libraryFetch({ lift: false }) });
  client.configure(
    frameApiHooks({
      app: "console",
      router,
      fallbackFrame: "app",
      viewer: fin.viewer,
      stepUp: fin.stepUp,
      release: createReleaseWatch(fin.env.release, (release) => fin.newRelease.set(release)),
      reload: () => window.location.reload(),
      report: reportBrowserError,
    }),
  );
  hooked.set(fin, client.api);
  return client.api;
}
