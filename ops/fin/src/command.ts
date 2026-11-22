// The shape of a `pnpm fin` command. Each command module exports a list of these; cli.ts finds the
// one the words name, parses its arguments, builds its context and runs it.

import type { FlagSpec, PositionalSpec } from "./core/args.ts";
import type { Context } from "./core/context.ts";

export interface Command {
  /** The words that name it, for example ["zone", "apply"]. */
  words: readonly string[];
  summary: string;
  /** The arguments after the environment. */
  positionals: readonly PositionalSpec[];
  flags: readonly FlagSpec[];
  /** Whether it reads the overlay (most do). */
  overlay: boolean;
  /** Whether it can change a provider: it then takes --dry-run and runs registered. */
  mutating: boolean;
  /** The runbook in docs/runbooks/ that explains it. */
  runbook: string;
  run(ctx: Context): Promise<number>;
}

/** The flags every mutating command takes. */
export const MUTATING_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", kind: "boolean", description: "print the plan and send nothing" },
  {
    name: "confirm-delete",
    kind: "integer",
    description: "allow a plan with exactly this many deletions",
  },
  { name: "spike", kind: "boolean", description: "allow the overlay's spike-only names" },
  { name: "fallback", kind: "boolean", description: "allow the overlay's fallback-only names" },
];
