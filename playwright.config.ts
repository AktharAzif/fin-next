// The root Playwright configuration (spec 01 §4.7, L-SAT-08). The projects, the static hosts and
// the CI settings live in @fin/testing; run it with `pnpm --filter @fin/testing e2e` (which
// passes this file), or `pnpm exec playwright test` once the root lists @playwright/test.
import { finPlaywrightConfig } from "./packages/testing/src/playwright/config.ts";

export default finPlaywrightConfig(import.meta.dirname);
