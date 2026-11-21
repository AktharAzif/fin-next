// The GitHub facts a review run reads (spec 07 §2.3.3, [CI-15]): a pull request's head SHA, its base
// branch and base SHA, the repository's default branch, its state and whether it comes from the
// same repository. Nothing else is read: never a title, body, comment or branch name of the head, so
// no session can be shown one.

import { runProgram } from "./exec.ts";
import { isSha } from "./git.ts";
import { isJsonObject, parseJsonBytes } from "./json.ts";
import { RemoteError, isPrNumber, isRefName } from "./review/repo.ts";

export interface PullFacts {
  readonly head: string;
  readonly baseRef: string;
  readonly baseSha: string;
  /** The repository's default branch: tiers and the review's scope come from it (spec 07 §2.4). */
  readonly defaultBranch: string;
  readonly state: "open" | "closed";
  readonly sameRepository: boolean;
}

const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GH_TIMEOUT_MS = 60_000;
/** The only fields read (a jq filter, so nothing else leaves gh). */
export const PULL_FILTER =
  "{head: .head.sha, baseRef: .base.ref, baseSha: .base.sha, defaultBranch: .base.repo.default_branch, state: .state, sameRepository: (.head.repo.full_name == .base.repo.full_name)}";

/** The `gh` argument list for one pull request's facts. */
export function pullFactsArgs(slug: string, pr: number): string[] {
  if (!SLUG_RE.test(slug) || slug.split("/").some((part) => part.startsWith("."))) throw new TypeError("refusing a repository slug");
  if (!Number.isInteger(pr) || !isPrNumber(String(pr))) throw new TypeError("refusing a pull request number");
  return ["api", `repos/${slug}/pulls/${pr}`, "--jq", PULL_FILTER];
}

/** Parses gh's answer. Throws RemoteError on anything unexpected. */
export function parsePullFacts(stdout: Uint8Array): PullFacts {
  const parsed = parseJsonBytes(stdout);
  if (!parsed.ok || !isJsonObject(parsed.value)) throw new RemoteError("gh returned no JSON object for the pull request");
  const { head, baseRef, baseSha, defaultBranch, state, sameRepository } = parsed.value;
  if (!isSha(head) || !isSha(baseSha)) throw new RemoteError("gh returned a head or base that is not a SHA");
  if (typeof baseRef !== "string" || !isRefName(baseRef)) throw new RemoteError("gh returned a base branch name the engine refuses");
  if (typeof defaultBranch !== "string" || !isRefName(defaultBranch)) throw new RemoteError("gh returned a default branch name the engine refuses");
  if (state !== "open" && state !== "closed") throw new RemoteError("gh returned an unknown pull request state");
  if (typeof sameRepository !== "boolean") throw new RemoteError("gh returned no same-repository flag");
  return Object.freeze({ head, baseRef, baseSha, defaultBranch, state, sameRepository });
}

/**
 * Reads a pull request's facts with `gh api`, run in `cwd` (an engine-owned folder: the program
 * lookup never takes gh from a PATH folder in or below the working directory, so `/` would find
 * none). Throws RemoteError when gh fails.
 */
export async function pullFacts(slug: string, pr: number, cwd: string, env: Readonly<Record<string, string | undefined>>): Promise<PullFacts> {
  const args = pullFactsArgs(slug, pr);
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) clean[name] = value;
  clean["GH_PROMPT_DISABLED"] = "1";
  clean["NO_COLOR"] = "1";
  let result;
  try {
    result = await runProgram("gh", args, { cwd, env: clean, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 1 << 20 });
  } catch (error) {
    throw new RemoteError(`gh could not be run: ${(error as Error).message}`);
  }
  if (result.code !== 0) {
    const first = result.stderr.toString("utf8").split("\n").find((line) => line.trim() !== "") ?? "";
    throw new RemoteError(`gh api failed (exit ${result.code ?? "signal"})${first === "" ? "" : `: ${first.slice(0, 200)}`}`);
  }
  return parsePullFacts(result.stdout);
}
