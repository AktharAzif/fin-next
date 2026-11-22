// `pnpm --filter @fin/ops-monitoring monitoring:check`: runs monitoring:check from the repository
// root and exits 1 on any finding. No network.
import { join } from "node:path";
import { checkMonitoring, formatFindings } from "./check.ts";

const root = join(import.meta.dirname, "..", "..", "..");
const started = performance.now();
const findings = checkMonitoring(root);
const ms = Math.round(performance.now() - started);
if (findings.length > 0) {
  process.stderr.write(
    `${formatFindings(findings)}\nmonitoring:check: ${findings.length} finding(s)\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`monitoring:check: clean (${ms} ms)\n`);
}
