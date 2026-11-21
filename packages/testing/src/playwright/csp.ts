// The `securitypolicyviolation` fixture's engine (spec 06 §6.4, AC-SAT-18; FW-C17): an init
// script in every frame of every page records each violation event, and every console message
// about the page policy is kept too, so a test fails on any of them. No test sets bypassCSP.
import type { BrowserContext, ConsoleMessage } from "@playwright/test";

export interface CspViolation {
  readonly source: "event" | "console";
  /** The page (or frame) that saw it. */
  readonly documentUrl: string;
  readonly directive: string;
  readonly blockedUrl: string;
  readonly disposition: string;
  readonly sample: string;
  readonly text: string;
}

/** The binding the init script reports through. */
export const CSP_BINDING = "__finCspViolation";

/** Runs in the page before any of its own scripts, in every frame. */
export const CSP_INIT_SCRIPT = `(() => {
  const report = globalThis[${JSON.stringify(CSP_BINDING)}];
  if (typeof report !== "function") return;
  document.addEventListener("securitypolicyviolation", (event) => {
    report({
      documentUrl: String(event.documentURI || location.href),
      directive: String(event.effectiveDirective || event.violatedDirective || ""),
      blockedUrl: String(event.blockedURI || ""),
      disposition: String(event.disposition || ""),
      sample: String(event.sample || ""),
    });
  }, true);
})();`;

/** Console text the three engines write when the page policy blocks something. */
const POLICY_MESSAGE =
  /content[- ]security[- ]policy|\bCSP\b|Refused to (?:load|execute|apply|connect|frame|create|evaluate|compile|run)/i;

export function isPolicyConsoleMessage(text: string): boolean {
  return POLICY_MESSAGE.test(text);
}

export interface CspWatcher {
  readonly violations: readonly CspViolation[];
  /** Throws, listing every violation, when there is any. */
  assertNone(): void;
  /** Forgets what was seen (for a test that provokes a violation on purpose). */
  clear(): void;
}

function describe(violation: CspViolation): string {
  if (violation.source === "console") return `console: ${violation.text}`;
  const blocked = violation.blockedUrl === "" ? "" : ` blocked ${violation.blockedUrl}`;
  return `${violation.directive}${blocked} on ${violation.documentUrl}`;
}

/** Starts recording for a context. Call before its first page opens. */
export async function watchCsp(context: BrowserContext): Promise<CspWatcher> {
  const violations: CspViolation[] = [];
  await context.exposeBinding(CSP_BINDING, (_source, raw: unknown) => {
    const event = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const field = (name: string) =>
      typeof event[name] === "string" ? (event[name] as string) : "";
    violations.push({
      source: "event",
      documentUrl: field("documentUrl"),
      directive: field("directive"),
      blockedUrl: field("blockedUrl"),
      disposition: field("disposition"),
      sample: field("sample"),
      text: "",
    });
  });
  await context.addInitScript({ content: CSP_INIT_SCRIPT });
  context.on("console", (message: ConsoleMessage) => {
    const text = message.text();
    if (!isPolicyConsoleMessage(text)) return;
    violations.push({
      source: "console",
      documentUrl: message.page()?.url() ?? "",
      directive: "",
      blockedUrl: "",
      disposition: "",
      sample: "",
      text,
    });
  });
  return {
    violations,
    assertNone() {
      if (violations.length === 0) return;
      const list = violations.map((v) => `  - ${describe(v)}`).join("\n");
      throw new Error(`the page policy was violated ${violations.length} time(s):\n${list}`);
    },
    clear() {
      violations.length = 0;
    },
  };
}
