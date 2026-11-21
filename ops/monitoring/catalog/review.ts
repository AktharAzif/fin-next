// The review area's lines (spec 07 §12.2), written by tools/fin-review's run (`lines.write`) to
// the run's own lines.jsonl. They are local only for now: nothing ships them to Better Stack's
// fin-review sources yet, so no alert can read them. The alerts spec 07 §12.3 names come with the
// review area's alert fragment (alerts/review.json) and the shipping; until then each entry names
// the alert it is owed. The rest of §12.2's lines join here when the code writes them.
import type { CatalogEntry } from "./types.ts";

const LOCAL =
  "Written only to the run's local lines.jsonl, which nothing ships yet; the run's own result shows it to whoever started the run";

export const entries: readonly CatalogEntry[] = [
  {
    event: "review.run",
    kind: "unit",
    level: "info",
    writtenBy: "fin-review, once at the end of every review run",
    fields: {
      mode: "string",
      pr: "number",
      tier: "string",
      result: "string",
      sessions: "number",
      costMicroUsd: "number",
      findings: "number",
      blockers: "number",
    },
    alerts: [],
  },
  {
    event: "review.refused",
    kind: "failure",
    level: "warn",
    writtenBy: "fin-review, for a session whose lens or profile refused or did not finish",
    fields: { session: "string", role: "string", failure: "string" },
    alerts: [],
    noAlert: `${LOCAL}; review-refusals (N, spec 07 §12.3) is owed by the review area's alert fragment`,
  },
  {
    event: "review.model_mismatch",
    kind: "security",
    level: "error",
    writtenBy:
      "fin-review, when a session reports another model than the one it asked for; the run blocks",
    fields: { session: "string", role: "string", requested: "string", observed: "string" },
    alerts: [],
    noAlert: `${LOCAL}; review-model-mismatch (P, spec 07 §12.3) is owed by the review area's alert fragment`,
  },
  {
    event: "review.lock_broken",
    kind: "info",
    level: "info",
    writtenBy: "fin-review, when it removes a pull request's stale review lock",
    fields: { staleRunId: "string", why: "string" },
    alerts: [],
  },
];
