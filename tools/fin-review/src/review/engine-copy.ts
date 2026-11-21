// The engine copy (spec 07 §0.3): every gating review runs the default branch's engine over the pull
// request's tree as data, so a pull request is never reviewed by its own procedure. The checkout the
// engine runs from must be clean under tools/fin-review, docs/review, AGENTS.md and CONTRIBUTING.md
// (untracked and ignored files included) and hold, tree for tree, what the default branch holds
// there; otherwise a gating run is refused and only an advisory one goes ahead. Every run records the
// engine's commit and the procedure hash of §4.8: the SHA-256 of the sorted `<path> <blob id>` lines
// of every file under docs/review/ and tools/fin-review/config/ at that commit, which a `commit` run
// compares with its prior run's.

import { createHash } from "node:crypto";
import { escapeText } from "../display.ts";
import { canonicalPath } from "../exec.ts";
import { checkoutState, filesUnder, objectAt } from "./repo.ts";

/** What the engine reads from its own checkout: the code, the procedure and the rules files. */
export const ENGINE_PATHS: readonly string[] = ["tools/fin-review", "docs/review", "AGENTS.md", "CONTRIBUTING.md"];
/** The paths a default branch must hold for it to have an engine copy at all. */
const REQUIRED_PATHS: ReadonlySet<string> = new Set(["tools/fin-review", "docs/review"]);
/** What the procedure hash covers (spec 07 §4.8). */
export const PROCEDURE_PATHS: readonly string[] = ["docs/review", "tools/fin-review/config"];
const MAX_LISTED = 10;

export interface EngineCopy {
  /** The engine checkout's commit, or null when it is not a git checkout. */
  readonly commit: string | null;
  /** The procedure hash at that commit, or null. */
  readonly procedureHash: string | null;
  /** Why the engine is not the default branch's engine copy; empty when it is. */
  readonly problems: readonly string[];
}

export interface EngineCopyInput {
  readonly mirror: string;
  readonly defaultBranch: string;
  readonly defaultTip: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The procedure hash of `[path, blob id]` lines (spec 07 §4.8). */
export function procedureHash(files: ReadonlyArray<readonly [string, string]>): string {
  const lines = files.map(([path, oid]) => `${path} ${oid}`).sort();
  return createHash("sha256").update(`${lines.join("\n")}\n`, "utf8").digest("hex");
}

/** Checks the engine checkout at `engineRoot` against the default branch's tip in the mirror. */
export async function checkEngineCopy(engineRoot: string, input: EngineCopyInput): Promise<EngineCopy> {
  const state = await checkoutState(engineRoot, ENGINE_PATHS, input.env);
  if (state === null) return { commit: null, procedureHash: null, problems: ["the engine does not run from a git checkout"] };
  const problems: string[] = [];
  if (canonicalPath(state.top) !== canonicalPath(engineRoot)) problems.push("the engine's folder is not the top of its git checkout");
  if (state.changed.length > 0) {
    const listed = state.changed
      .slice(0, MAX_LISTED)
      .map((path) => escapeText(path, 200))
      .join(", ");
    problems.push(`the engine checkout has changes under ${ENGINE_PATHS.join(", ")}: ${listed}${state.changed.length > MAX_LISTED ? ", ..." : ""}`);
  }
  for (const path of ENGINE_PATHS) {
    const ours = await objectAt(engineRoot, state.head, path, input.env);
    const theirs = await objectAt(input.mirror, input.defaultTip, path, input.env);
    if (theirs === null && REQUIRED_PATHS.has(path)) problems.push(`${input.defaultBranch} has no ${path}, so there is no engine copy to run`);
    else if (ours !== theirs) problems.push(`${path} at the engine's commit differs from ${input.defaultBranch}'s`);
  }
  return { commit: state.head, procedureHash: procedureHash(await filesUnder(engineRoot, state.head, PROCEDURE_PATHS, input.env)), problems };
}
