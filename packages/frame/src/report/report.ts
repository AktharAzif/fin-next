// The browser's one error-reporting seam (spec 06 §2.6). Everything that throws in the UI comes
// here with IDs only, never a value a person typed. Until the reporter loads after the first paint
// (the Sentry relay of `/api/monitoring/envelope`, installed by the lane that owns it), reports wait
// in a queue of at most 20, oldest dropped. `window.onerror` and `unhandledrejection` go through
// the same seam, and the browser's own print of them (the whole error) is cancelled: the console
// hears them only reduced, as the console guard reduces everything (spec 06 §2.3 step 1).
import { safeConsoleValue } from "./console-guard.ts";

export type ReportIds = Readonly<Record<string, string>>;
export type ReportSink = (error: unknown, ids: ReportIds) => void;

export const REPORT_QUEUE_LIMIT = 20;

interface Pending {
  error: unknown;
  ids: ReportIds;
}

let sink: ReportSink | null = null;
const queue: Pending[] = [];

/** Reports a browser error with identifiers only. Never throws. */
export function reportBrowserError(error: unknown, ids: ReportIds = {}): void {
  if (sink !== null) {
    try {
      sink(error, ids);
    } catch {
      // A reporter that fails must not take the page with it.
    }
    return;
  }
  queue.push({ error, ids });
  if (queue.length > REPORT_QUEUE_LIMIT) queue.shift();
}

/** Installs the reporter and hands it everything queued so far, oldest first. */
export function setReportSink(next: ReportSink | null): void {
  sink = next;
  if (next === null) return;
  for (const pending of queue.splice(0)) {
    try {
      next(pending.error, pending.ids);
    } catch {
      // As above.
    }
  }
}

/** How many reports are waiting for a reporter (for tests and the kit). */
export function pendingReports(): number {
  return queue.length;
}

/** A reported failure as one console line for whoever has the console open: reduced, never whole. */
export type ReportedPrinter = (source: string, error: unknown) => void;

export const printReported: ReportedPrinter = (source, error) => {
  // biome-ignore lint/suspicious/noConsole: the frame's one print of a failure it has reported, reduced by safeConsoleValue first.
  globalThis.console.error(`${source}:`, safeConsoleValue(error));
};

/**
 * Sends `error` and `unhandledrejection` to the seam, and cancels the browser's own print of them,
 * which would show the error whole; `print` says it reduced instead. Returns the remover.
 */
export function installGlobalErrorReporting(
  target: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  print: ReportedPrinter = printReported,
): () => void {
  const onError = (event: ErrorEvent) => {
    event.preventDefault();
    const error: unknown = event.error ?? event.message;
    reportBrowserError(error, { source: "window.onerror" });
    print("window.onerror", error);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    event.preventDefault();
    reportBrowserError(event.reason, { source: "unhandledrejection" });
    print("unhandledrejection", event.reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}

/**
 * React's failure handlers for `createRoot` (React 19). Its defaults hand an uncaught or a
 * recoverable error to `window.reportError`, whose print shows the error whole; these report it
 * through the seam and print it reduced. Caught errors (a route's error boundary) keep React's
 * default, which prints through the console guard.
 */
export function reactFailureHandlers(print: ReportedPrinter = printReported): {
  onUncaughtError: (error: unknown) => void;
  onRecoverableError: (error: unknown) => void;
} {
  return {
    onUncaughtError: (error) => {
      reportBrowserError(error, { source: "react.uncaught" });
      print("react.uncaught", error);
    },
    onRecoverableError: (error) => {
      reportBrowserError(error, { source: "react.recoverable" });
      print("react.recoverable", error);
    },
  };
}
