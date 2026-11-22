// Argument parsing: `pnpm fin <group> <command> <env> [arguments] [--flags]`. Strict on purpose:
// an unknown command, flag or value is a usage error (exit 64), never ignored, because a typo in an
// operator command must not quietly do something else.

import { UsageError } from "./errors.ts";

export type FlagKind = "boolean" | "string" | "integer";

export interface FlagSpec {
  name: string;
  kind: FlagKind;
  description: string;
  /** For a string flag: the values it accepts. */
  values?: readonly string[];
}

export interface PositionalSpec {
  name: string;
  description: string;
  values?: readonly string[];
}

export interface ParsedArgs {
  positionals: string[];
  flags: Map<string, string | number | boolean>;
}

export interface ArgsSpec {
  positionals: readonly PositionalSpec[];
  flags: readonly FlagSpec[];
}

/** Parses the arguments after the command's words against its spec. */
export function parseArgs(argv: readonly string[], spec: ArgsSpec): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | number | boolean>();
  const byName = new Map(spec.flags.map((f) => [f.name, f]));
  let flagsEnded = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (!flagsEnded && arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (flagsEnded || !arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const flag = byName.get(name);
    if (flag === undefined) throw new UsageError(`unknown flag --${name}`);
    if (flags.has(name)) throw new UsageError(`--${name} is given twice`);
    if (flag.kind === "boolean") {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      flags.set(name, true);
      continue;
    }
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) {
      throw new UsageError(`--${name} needs a value`);
    }
    if (flag.kind === "integer") {
      if (!/^\d{1,6}$/.test(value)) throw new UsageError(`--${name} must be a whole number`);
      flags.set(name, Number(value));
      continue;
    }
    if (flag.values !== undefined && !flag.values.includes(value)) {
      throw new UsageError(`--${name} must be one of ${flag.values.join(", ")}`);
    }
    flags.set(name, value);
  }
  if (positionals.length !== spec.positionals.length) {
    const names = spec.positionals.map((p) => `<${p.name}>`).join(" ");
    throw new UsageError(
      `expected ${spec.positionals.length} argument(s) (${names}), got ${positionals.length}`,
    );
  }
  spec.positionals.forEach((p, i) => {
    const value = positionals[i] ?? "";
    if (p.values !== undefined && !p.values.includes(value)) {
      throw new UsageError(`<${p.name}> must be one of ${p.values.join(", ")}`);
    }
  });
  return { positionals, flags };
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) === true;
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function flagInt(args: ParsedArgs, name: string): number | undefined {
  const value = args.flags.get(name);
  return typeof value === "number" ? value : undefined;
}
