// The browser's one error-reporting seam (spec 06 §2.6). Everything that throws in the UI comes
// here with IDs only, never a value a person typed. Until the reporter loads after the first paint
// (the Sentry relay of `/api/monitoring/envelope`, installed by the lane that owns it), reports wait
// in a queue of at most 20, oldest dropped. `window.onerror` and `unhandledrejection` go through
// the same seam.

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

/** Sends `error` and `unhandledrejection` to the seam. Returns the remover. */
export function installGlobalErrorReporting(target: Window = window): () => void {
  const onError = (event: ErrorEvent) =>
    reportBrowserError(event.error ?? event.message, { source: "window.onerror" });
  const onRejection = (event: PromiseRejectionEvent) =>
    reportBrowserError(event.reason, { source: "unhandledrejection" });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
  };
}
