// `pnpm fin <group> <command> <env> [arguments] [--flags]`: finds the command, parses its
// arguments strictly, builds its context (the overlay is masked before anything prints), takes the
// run lock for a mutating run before the command reads anything, and runs it. Every error leaves
// through the masker with its exit code, and is printed before the run is closed, so closing the
// run can never hide it. Telemetry never changes the exit code. While a run holds the lock, SIGINT
// and SIGTERM close it as failed (run.done, the lock released, the lines kept and shipped) before
// the process exits 130 or 143.

import type { Command } from "./command.ts";
import { MUTATING_FLAGS } from "./command.ts";
import { CORE_COMMANDS } from "./commands/core.ts";
import { parseArgs } from "./core/args.ts";
import { Context, resultOf } from "./core/context.ts";
import { EXIT, FinError, UsageError } from "./core/errors.ts";
import { Masker } from "./core/mask.ts";
import { Output } from "./core/output.ts";
import type { Runtime } from "./core/runtime.ts";
import { ENVIRONMENTS, isEnvironment, loadSettings } from "./core/settings.ts";

export const COMMANDS: readonly Command[] = [...CORE_COMMANDS];

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

/** While the run holds the lock, an interrupt closes it before the process exits. */
function trapInterrupts(ctx: Context, runtime: Runtime, out: Output): () => void {
  return runtime.trap(async (signal) => {
    out.error(`interrupted (${signal}): closing the run`);
    if (ctx.run.registered && !ctx.run.finished) {
      ctx.run.finish("failed", { error: `interrupted by ${signal}` });
    } else ctx.run.close();
    await ctx.run.flushLines();
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
      // Before the command reads any provider state, so its plan cannot go stale under another run.
      ctx.run.acquire();
      if (ctx.run.locked) untrap = trapInterrupts(ctx, runtime, out);
    }
    return await command.run(ctx);
  } catch (error) {
    const code = report(out, error);
    if (ctx?.run.registered && !ctx.run.finished) {
      try {
        ctx.run.finish(resultOf(error), {
          error: error instanceof Error ? error.message : "failed",
        });
      } catch {
        out.warn("the run could not be closed in the run log");
      }
    }
    return code;
  } finally {
    untrap?.();
    if (ctx !== undefined) {
      try {
        ctx.run.close();
      } catch {
        out.warn("the run could not be closed");
      }
      try {
        await ctx.run.flushLines();
      } catch {
        // Telemetry never changes the exit code; flushLines warns itself.
      }
    }
  }
}
