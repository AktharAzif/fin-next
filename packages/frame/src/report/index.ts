// `@fin/frame/report` (spec 06 §2.3 step 1): each app's main.tsx imports it straight after its
// stylesheet and before everything else, so the scrubbing console guard is in place before any
// library is evaluated. Importing it installs the guard (a declared side effect in package.json);
// startApp installs it again, which does nothing once it is there. It also exports the report seam.
import { installConsoleGuard } from "./console-guard.ts";

installConsoleGuard();

export { installConsoleGuard, safeConsoleValue } from "./console-guard.ts";
export {
  installGlobalErrorReporting,
  pendingReports,
  REPORT_QUEUE_LIMIT,
  type ReportIds,
  type ReportSink,
  reportBrowserError,
  setReportSink,
} from "./report.ts";
