// `pnpm fin <group> <command> <env> [arguments] [--flags]`: finds the command, parses its
// arguments strictly, builds its context (the overlay is masked before anything prints), takes the
// run lock for a mutating run before the command reads anything, and runs it. Every error leaves
// through the masker with its exit code, and is printed before the run is closed, so closing the
// run can never hide it. Telemetry never changes the exit code. From just before a mutating run
// takes the lock until it has released it, a stop (SIGINT, SIGTERM, SIGHUP; with main.ts's guards,
// a closed standard output or error, or an uncaught error) closes it as failed: no further change
// starts, the change in flight is given time to settle and is recorded if it does, then the plan's
// cleanup (PlanHooks.cleanup), run.done, the lock released and the lines kept and shipped, before
// the process exits 130, 143, 129 or 70. SIGQUIT, a later second Ctrl-C or SIGTERM, and the
// clean-up's deadline close it at once instead (run.done naming the change in flight, what the
// cleanup has not done printed as something to do by hand, the lock released) and exit
// (core/runtime.ts). However the run closes, run.done records what the cleanup left to do by hand
// or failed with, and a run.leftover line goes with it (Context.finishRun): the output may have
// no reader (a closed terminal).

import type { Command } from "./command.ts";
import { MUTATING_FLAGS } from "./command.ts";
import { CLOUDFLARE_COMMANDS } from "./commands/cloudflare.ts";
import { CORE_COMMANDS } from "./commands/core.ts";
import { DEPLOY_COMMANDS } from "./commands/deploy.ts";
import { parseArgs } from "./core/args.ts";
import { Context, messageOf, resultOf } from "./core/context.ts";
import { EXIT, FinError, UsageError } from "./core/errors.ts";
import { Masker } from "./core/mask.ts";
import { Output } from "./core/output.ts";
import {
  type ForcedClose,
  INTERRUPT_SETTLE_MS,
  type Runtime,
  stopDescription,
} from "./core/runtime.ts";
import { ENVIRONMENTS, isEnvironment, loadSettings } from "./core/settings.ts";

export const COMMANDS: readonly Command[] = [
  ...CORE_COMMANDS,
  ...CLOUDFLARE_COMMANDS,
  ...DEPLOY_COMMANDS,
];

function usage(commands: readonly Command[]): string {
  const lines = ["usage: pnpm fin <command> <env> [arguments] [--flags]", "", "commands:"];
  for (const c of commands) {
    const args = c.positionals.map((p) => ` <${p.name}>`).join("");
    lines.push(`  ${c.words.join(" ")} <env>${args}`.padEnd(44) + c.summary);
  }
  lines.push("", `environments: ${ENVIRONMENTS.join(", ")}`, "runbooks: docs/runbooks/");
  return lines.join("\n");
}

function commandHelp(c: Command): string {
  const flags = c.mutating ? [...c.flags, ...MUTATING_FLAGS] : c.flags;
  const lines = [
    `usage: pnpm fin ${c.words.join(" ")} <env>${c.positionals.map((p) => ` <${p.name}>`).join("")}`,
    "",
    c.summary,
  ];
  for (const p of c.positionals) {
    lines.push(`  <${p.name}>  ${p.description}${p.values ? ` (${p.values.join(" | ")})` : ""}`);
  }
  for (const f of flags)
    lines.push(`  --${f.name}${f.kind === "boolean" ? "" : " <value>"}  ${f.description}`);
  lines.push("", `runbook: docs/runbooks/${c.runbook}`);
  return lines.join("\n");
}

/** Prints an error, masked, and returns its exit code. */
function report(out: Output, error: unknown): number {
  if (error instanceof FinError) {
    out.error(error.message);
    return error.exitCode;
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "an unknown error";
  out.error(`internal error: ${message}`);
  return EXIT.internal;
}

/**
 * While the run may hold the lock, a stop closes it before the process exits: the run is marked
 * stopped so no further change starts; a change in flight gets up to INTERRUPT_SETTLE_MS to settle
 * (applyPlan then records it, runs the plan's cleanup and closes the run); a run still open after
 * that has the plan's cleanup run here (a one-run token revoked, a superuser reference removed,
 * while the run may still write) and is then closed, its run.done naming the change in flight. An
 * uncaught error does not wait. A run that registered nothing has its lock released. When the stop
 * insists (closeNow), the run is closed at once, and what the cleanup has not done yet is printed
 * as something to do by hand. Either way, run.done records what the cleanup has not undone
 * (`leftover`, and `cleanupFailed` with `cleanupError` when it failed) and a run.leftover line goes
 * with it, so a stop with no one reading the output still leaves the instruction on record.
 */
function trapStops(ctx: Context, runtime: Runtime, out: Output): () => void {
  return runtime.trap({
    stop: async (cause) => {
      out.error(`${stopDescription(cause)}: closing the run`);
      ctx.run.stop(cause);
      if (ctx.run.registered && !ctx.run.finished) {
        if (ctx.run.inFlight !== undefined && cause !== "uncaught-error") {
          await Promise.race([ctx.run.closed, runtime.sleep(INTERRUPT_SETTLE_MS)]);
        }
        if (!ctx.run.finished) {
          try {
            await ctx.cleanUp();
          } catch {
            // The cleanup said what to do by hand, and run.done records it (finishRun).
          }
        }
        ctx.finishRun("failed", { error: stopDescription(cause) });
      } else ctx.run.close();
      await ctx.run.flushLines();
    },
    closeNow: (why: ForcedClose) => {
      if (why !== "deadline") ctx.run.stop(why);
      if (ctx.run.finished) {
        if (why === "deadline") {
          out.warn("the clean-up did not finish in time; the lines not shipped stay local");
        }
        return;
      }
      const what =
        why === "deadline" ? "the clean-up did not finish in time" : stopDescription(why);
      out.error(`${what}: closing the run at once`);
      if (!ctx.run.registered) {
        ctx.run.close();
        return;
      }
      // Printed for whoever is watching, and recorded by finishRun for whoever is not.
      try {
        const left = ctx.leftover();
        if (left !== undefined) out.error(left);
      } catch {
        // finishRun records that it could not be read.
      }
      const stopped = ctx.run.stopped;
      ctx.finishRun("failed", {
        error: stopped === undefined ? what : stopDescription(stopped),
        forced: why,
      });
    },
  });
}

/** Runs one invocation and returns its exit code. It never rejects. */
export async function runCli(
  argv: readonly string[],
  runtime: Runtime,
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  const masker = new Masker();
  const out = new Output(runtime, masker);
  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    runtime.stdout(`${usage(commands)}\n`);
    return argv.length === 0 ? EXIT.usage : EXIT.ok;
  }
  const command = [...commands]
    .sort((a, b) => b.words.length - a.words.length)
    .find((c) => c.words.every((w, i) => argv[i] === w));
  if (command === undefined) {
    out.error(`unknown command: ${argv.slice(0, 2).join(" ")} (pnpm fin help lists them)`);
    return EXIT.usage;
  }
  const rest = argv.slice(command.words.length);
  if (rest.includes("--help") || rest.includes("-h")) {
    runtime.stdout(`${commandHelp(command)}\n`);
    return EXIT.ok;
  }
  let ctx: Context | undefined;
  let untrap: (() => void) | undefined;
  try {
    const environment = rest[0];
    if (environment === undefined || environment.startsWith("--")) {
      throw new UsageError(
        `${command.words.join(" ")} needs an environment (${ENVIRONMENTS.join(", ")})`,
      );
    }
    if (!isEnvironment(environment)) {
      throw new UsageError(`unknown environment "${environment}" (${ENVIRONMENTS.join(", ")})`);
    }
    const args = parseArgs(rest.slice(1), {
      positionals: command.positionals,
      flags: command.mutating ? [...command.flags, ...MUTATING_FLAGS] : command.flags,
    });
    const settings = loadSettings(runtime.repoRoot, environment);
    ctx = new Context({
      runtime,
      environment,
      settings,
      masker,
      out,
      args,
      command: command.words.join(" "),
      mutating: command.mutating,
      needsOverlay: command.overlay,
    });
    if (command.mutating) {
      // The trap comes first: a signal from the moment the lock exists closes the run and frees
      // the lock, instead of killing the process with the lock held. A dry run takes no lock.
      if (!ctx.dryRun) untrap = trapStops(ctx, runtime, out);
      // Before the command reads any provider state, so its plan cannot go stale under another run.
      ctx.run.acquire();
    }
    return await command.run(ctx);
  } catch (error) {
    const code = report(out, error);
    if (ctx?.run.registered && !ctx.run.finished) {
      try {
        ctx.finishRun(resultOf(error), { error: messageOf(error) });
      } catch {
        out.warn("the run could not be closed in the run log");
      }
    }
    return code;
  } finally {
    if (ctx !== undefined) {
      try {
        ctx.run.close();
      } catch {
        out.warn("the run could not be closed");
      }
    }
    // Only once the lock is released: until then a signal closes the run, never kills it.
    untrap?.();
    if (ctx !== undefined) {
      try {
        await ctx.run.flushLines();
      } catch {
        // Telemetry never changes the exit code; flushLines warns itself.
      }
    }
  }
}
