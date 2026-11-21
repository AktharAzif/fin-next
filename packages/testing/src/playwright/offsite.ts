// The off-origin request fixture's engine (spec 06 §10.2, AC-UI-30): nothing a page loads at run
// time comes from another origin (fonts, icons and scripts included), except the origins a
// project lists (only the selfie page's Sumsub hosts, [SA-26]).
import type { BrowserContext, Request } from "@playwright/test";

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

/** Records every request from the context's pages to an origin outside `allowedOrigins`. */
export function watchOffsite(
  context: BrowserContext,
  allowedOrigins: readonly string[],
): OffsiteWatcher {
  const allowed = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
  const requests: OffsiteRequest[] = [];
  context.on("request", (request: Request) => {
    if (!isOffsite(request.url(), allowed)) return;
    let pageUrl = "";
    try {
      pageUrl = request.frame().url();
    } catch {
      pageUrl = "";
    }
    requests.push({ url: request.url(), resourceType: request.resourceType(), pageUrl });
  });
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
