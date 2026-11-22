// The off-origin request fixture's engine (spec 06 §10.2, AC-UI-30): nothing a page loads at run
// time comes from another origin (fonts, icons, scripts and WebSockets included), except the
// origins a project lists (only the selfie page's Sumsub hosts, [SA-26]). A top-level navigation
// may also reach a navigation origin (the Access stand-in's login page in front of Fin Admin), from
// which nothing else may load.
import type { BrowserContext, Page, Request, WebSocket } from "@playwright/test";

export interface OffsiteRequest {
  readonly url: string;
  readonly resourceType: string;
  readonly pageUrl: string;
}

export interface OffsiteWatcher {
  readonly requests: readonly OffsiteRequest[];
  assertNone(): void;
  clear(): void;
}

export interface OffsiteOptions {
  /** Origins only a top-level document navigation may reach, such as the Access stand-in's. */
  readonly navigationOrigins?: readonly string[];
}

/** True when a request leaves the allowed origins (only http, https, ws and wss can). */
export function isOffsite(url: string, allowed: ReadonlySet<string>): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
  const origin =
    parsed.protocol === "ws:" || parsed.protocol === "wss:"
      ? `${parsed.protocol === "ws:" ? "http:" : "https:"}//${parsed.host}`
      : parsed.origin;
  return !allowed.has(origin);
}

function originsOf(list: readonly string[]): Set<string> {
  return new Set(list.map((origin) => new URL(origin).origin));
}

/** A navigation of a page's main frame (not a frame inside it, not a worker's request). */
function isTopLevelNavigation(request: Request): boolean {
  if (!request.isNavigationRequest() || request.resourceType() !== "document") return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false;
  }
}

/**
 * Records every request from the context's pages to an origin outside `allowedOrigins`: the
 * context's requests, and each page's WebSockets, which Playwright reports on the page and never
 * as a request.
 */
export function watchOffsite(
  context: BrowserContext,
  allowedOrigins: readonly string[],
  options: OffsiteOptions = {},
): OffsiteWatcher {
  const allowed = originsOf(allowedOrigins);
  const navigable = new Set([...allowed, ...originsOf(options.navigationOrigins ?? [])]);
  const requests: OffsiteRequest[] = [];
  context.on("request", (request: Request) => {
    const url = request.url();
    if (!isOffsite(url, isTopLevelNavigation(request) ? navigable : allowed)) return;
    let pageUrl = "";
    try {
      pageUrl = request.frame().url();
    } catch {
      pageUrl = "";
    }
    requests.push({ url, resourceType: request.resourceType(), pageUrl });
  });
  const watchPage = (page: Page) => {
    page.on("websocket", (socket: WebSocket) => {
      const url = socket.url();
      if (isOffsite(url, allowed))
        requests.push({ url, resourceType: "websocket", pageUrl: page.url() });
    });
  };
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
  return {
    requests,
    assertNone() {
      if (requests.length === 0) return;
      const list = requests.map((r) => `  - ${r.resourceType} ${r.url}`).join("\n");
      throw new Error(`a page requested another origin ${requests.length} time(s):\n${list}`);
    },
    clear() {
      requests.length = 0;
    },
  };
}
