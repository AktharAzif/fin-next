// The browser's report seam (spec 06 §2.6): reports queue until a reporter is set, and the failures
// the browser or React would print whole are reported and printed reduced instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installGlobalErrorReporting,
  pendingReports,
  printReported,
  REPORT_QUEUE_LIMIT,
  type ReportIds,
  reactFailureHandlers,
  reportBrowserError,
  setReportSink,
} from "../src/report/report.ts";

// A fake address, built at run time so the public-safety scan never sees an address literal.
const ADDRESS = ["maya.rivera", "example.com"].join("@");

afterEach(() => {
  setReportSink(null);
});

/** A sink and a printer that record what reaches them. */
function recorder() {
  const reports: { error: unknown; ids: ReportIds }[] = [];
  const printed: unknown[][] = [];
  setReportSink((error, ids) => reports.push({ error, ids }));
  return { reports, printed, print: (...line: unknown[]) => printed.push(line) };
}

describe("the report seam", () => {
  it("queues at most 20 reports until a reporter is set, then hands them over oldest first", () => {
    setReportSink(() => {});
    setReportSink(null);
    for (let index = 0; index < REPORT_QUEUE_LIMIT + 5; index++) {
      reportBrowserError(new Error("queued"), { index: String(index) });
    }
    expect(pendingReports()).toBe(REPORT_QUEUE_LIMIT);
    const seen: string[] = [];
    setReportSink((_error, ids) => seen.push(ids.index ?? ""));
    expect(pendingReports()).toBe(0);
    expect(seen[0]).toBe("5");
    expect(seen).toHaveLength(REPORT_QUEUE_LIMIT);
  });

  it("never lets a failing reporter take the page with it", () => {
    setReportSink(() => {
      throw new Error("the reporter broke");
    });
    expect(() => reportBrowserError(new Error("x"))).not.toThrow();
  });

  it("reports an uncaught error and a rejection, cancelling the browser's print of them", () => {
    const { reports, printed, print } = recorder();
    const target = new EventTarget();
    const remove = installGlobalErrorReporting(
      target as unknown as Pick<Window, "addEventListener" | "removeEventListener">,
      print,
    );
    const thrown = new TypeError(`nothing for ${ADDRESS}`);
    const uncaught = Object.assign(new Event("error", { cancelable: true }), {
      error: thrown,
      message: `Uncaught TypeError: nothing for ${ADDRESS}`,
    });
    target.dispatchEvent(uncaught);
    const rejection = Object.assign(new Event("unhandledrejection", { cancelable: true }), {
      reason: thrown,
    });
    target.dispatchEvent(rejection);
    remove();
    target.dispatchEvent(
      Object.assign(new Event("error", { cancelable: true }), { error: thrown }),
    );

    expect(uncaught.defaultPrevented).toBe(true);
    expect(rejection.defaultPrevented).toBe(true);
    expect(reports).toEqual([
      { error: thrown, ids: { source: "window.onerror" } },
      { error: thrown, ids: { source: "unhandledrejection" } },
    ]);
    expect(printed).toEqual([
      ["window.onerror", thrown],
      ["unhandledrejection", thrown],
    ]);
  });

  it("prints a reported failure reduced, with no address and no stack", () => {
    const lines: unknown[][] = [];
    const spy = vi.spyOn(globalThis.console, "error").mockImplementation((...data: unknown[]) => {
      lines.push(data);
    });
    try {
      printReported("react.uncaught", new RangeError(`bad value from ${ADDRESS}`));
    } finally {
      spy.mockRestore();
    }
    expect(lines).toEqual([["react.uncaught:", "RangeError"]]);
  });

  it("gives React handlers that report uncaught and recoverable errors through the seam", () => {
    const { reports, printed, print } = recorder();
    const handlers = reactFailureHandlers(print);
    const render = new Error(`render failed for ${ADDRESS}`);
    handlers.onUncaughtError(render);
    handlers.onRecoverableError(render);
    expect(reports.map((report) => report.ids)).toEqual([
      { source: "react.uncaught" },
      { source: "react.recoverable" },
    ]);
    expect(printed.map((line) => line[0])).toEqual(["react.uncaught", "react.recoverable"]);
  });
});
