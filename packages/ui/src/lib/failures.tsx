// Failure reporting (spec 06 §2.6, AC-UI-29). @fin/ui never logs an error: an action that throws
// (a Button's onClick, a MenuItem's onSelect) is handed to the reporter the app provides, which is
// @fin/frame's reportBrowserError, and the person is told "That didn't work. Try again.".
// The context carries IDs only; the reporter scrubs and sends.
import { createContext, type ReactNode, useContext } from "react";

export type FailureReporter = (error: unknown, ids: Readonly<Record<string, string>>) => void;

/** The sentence a failed action shows, from the inventory. */
export const ACTION_FAILED = "That didn’t work. Try again.";

const ignore: FailureReporter = () => {};
const Reporter = createContext<FailureReporter>(ignore);

/** Gives every control below it the app's reporter. Mount once, at the root. */
export function FailureReporterProvider(props: { report: FailureReporter; children: ReactNode }) {
  return <Reporter.Provider value={props.report}>{props.children}</Reporter.Provider>;
}

/** The same provider under the name the spec's component table uses. */
export const ReportFailures = FailureReporterProvider;

/** The reporter in scope; a no-op outside a provider (unit tests, the kit). */
export function useReportFailure(): FailureReporter {
  return useContext(Reporter);
}

/**
 * Runs an action, reporting a throw or a rejection and calling `onFailed` (to show the sentence)
 * before passing the failure on, so the SDK's pending and error states still see it.
 */
export function runReported(
  action: () => unknown,
  report: FailureReporter,
  ids: Readonly<Record<string, string>>,
  onFailed: () => void,
): unknown {
  const fail = (error: unknown) => {
    report(error, ids);
    onFailed();
    throw error;
  };
  try {
    const result = action();
    if (result instanceof Promise) return result.catch(fail);
    return result;
  } catch (error) {
    return fail(error);
  }
}
