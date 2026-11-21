// The core commands: checking the overlay, the run log and the run lock, and the two recorded ways
// past an incident (a stale lock, a run log that does not verify).

import type { Command } from "../command.ts";
import { flagString } from "../core/args.ts";
import type { Context } from "../core/context.ts";
import { EXIT, UsageError } from "../core/errors.ts";
import { HOST_ROLES } from "../core/overlay.ts";
import { type Head, parseHead } from "../core/runlog.ts";

/** A lock-break or log-restart reason: one line of printable text, long enough to say something. */
const REASON = /^[^\p{Cc}\p{Zl}\p{Zp}]{8,300}$/u;

/** The --reason a recorded override needs, checked; warns when it is logged unmasked. */
function reasonOf(ctx: Context, what: string): string {
  const reason = flagString(ctx.args, "reason")?.trim();
  if (reason === undefined || !REASON.test(reason)) {
    throw new UsageError(
      `${what} needs --reason "<why>": one line, 8 to 300 characters, naming roles, never a host or an ID`,
    );
  }
  if (!ctx.masked) {
    ctx.out.warn(
      "the overlay is not loaded (FIN_OVERLAY_FILE), so the reason is logged as typed: it must name roles, never a host or an ID",
    );
  }
  return reason;
}

const overlayCheck: Command = {
  words: ["overlay", "check"],
  summary: "validate the private overlay and print what it holds, masked",
  positionals: [],
  flags: [],
  overlay: true,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const o = ctx.overlay;
    ctx.out.info(`overlay for ${o.environment}: valid`);
    ctx.out.info(`  zone ${o.zone}`);
    for (const role of HOST_ROLES) {
      const host = o.hosts[role];
      if (host !== undefined) ctx.out.info(`  host ${role}: ${host}`);
    }
    ctx.out.info(
      `  allow-list: ${o.allowedNames.labels.length} labels, ${o.allowedNames.spikeOnly.length} spike-only, ` +
        `${o.allowedNames.fallbackOnly.length} fallback-only; never-touch: ${o.neverTouch.labels.length}`,
    );
    ctx.out.info(
      `  access: ${o.access.staff.length} staff address(es), ${o.access.allowDomains.length} domain(s)`,
    );
    if (o.access.staff.length === 0 && o.access.allowDomains.length === 0) {
      ctx.out.warn("access lists no staff address and no domain: Access would admit nobody");
    }
    ctx.out.info(`  ${ctx.masker.size} private values and forms registered for masking`);
    return EXIT.ok;
  },
};

const logVerify: Command = {
  words: ["log", "verify"],
  summary: "check the local run log's hash chain and its head",
  positionals: [],
  flags: [
    {
      name: "head",
      kind: "string",
      description:
        "a head that left this machine, <seq>:<sha256> from a run.done line's logSeq and logHead",
    },
  ],
  overlay: false,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const given = flagString(ctx.args, "head");
    let expected: Head | undefined;
    if (given !== undefined) {
      expected = parseHead(given);
      if (expected === undefined) throw new UsageError("--head takes <seq>:<sha256>");
    }
    const result = ctx.log.verify(expected);
    for (const note of result.notes) ctx.out.info(`run log: ${note}`);
    if (result.problems.length === 0) {
      const head =
        result.head === undefined
          ? ""
          : `; head: record ${result.head.seq}, sha256 ${result.head.hash}`;
      ctx.out.info(`run log: ${result.count} record(s), chain intact${head}`);
      return EXIT.ok;
    }
    for (const problem of result.problems) ctx.out.error(`run log: ${problem}`);
    return EXIT.drift;
  },
};

const lockStatus: Command = {
  words: ["lock", "status"],
  summary: "show who holds the run lock",
  positionals: [],
  flags: [],
  overlay: false,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const holder = ctx.log.holder();
    if (holder === undefined) ctx.out.info("run lock: free");
    else {
      ctx.out.info(
        `run lock: held by ${holder.runId} (${holder.command}) since ${holder.startedAt}, pid ${holder.pid} on ${holder.host}`,
      );
    }
    return EXIT.ok;
  },
};

const lockBreak: Command = {
  words: ["lock", "break"],
  summary: "break a stale run lock, with a reason that the run log keeps",
  positionals: [],
  flags: [{ name: "reason", kind: "string", description: "why the lock is broken (required)" }],
  overlay: false,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const reason = reasonOf(ctx, "lock break");
    const broken = ctx.log.breakLock(ctx.runtime.now(), ctx.run.id, reason, ctx.runtime.operator());
    if (broken === undefined) {
      ctx.out.info("run lock: already free");
      return EXIT.ok;
    }
    ctx.run.line("lock.broken", "warn", {
      holderRunId: broken.holder.runId,
      holderCommand: broken.holder.command,
      logSeq: broken.appended.record.seq,
      logHead: broken.appended.hash,
    });
    ctx.out.info(
      `run lock: broken (it was held by ${broken.holder.runId}, ${broken.holder.command})`,
    );
    return EXIT.ok;
  },
};

const logRestart: Command = {
  words: ["log", "restart"],
  summary: "after an incident, keep a run log that does not verify and start a new one",
  positionals: [],
  flags: [{ name: "reason", kind: "string", description: "why the log is restarted (required)" }],
  overlay: false,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const reason = reasonOf(ctx, "log restart");
    const restarted = ctx.log.restart(
      ctx.runtime.now(),
      ctx.run.id,
      reason,
      ctx.runtime.operator(),
    );
    if (restarted === undefined) {
      ctx.out.info("run log: it verifies; there is nothing to restart");
      return EXIT.ok;
    }
    const head = (h: Head | undefined) => (h === undefined ? null : { seq: h.seq, hash: h.hash });
    ctx.run.line("log.restarted", "warn", {
      problems: restarted.problems.length,
      previousHead: head(restarted.previousHead),
      previousHeadFile: head(restarted.previousHeadFile),
      logSeq: restarted.appended.record.seq,
      logHead: restarted.appended.hash,
    });
    for (const problem of restarted.problems) ctx.out.warn(`run log was: ${problem}`);
    const kept = [restarted.keptLog, restarted.keptHead].filter((n) => n !== undefined);
    ctx.out.info(
      `run log: restarted; the old one is kept beside it${kept.length > 0 ? ` (${kept.join(", ")})` : ""}; ` +
        `new head: record ${restarted.appended.record.seq}, sha256 ${restarted.appended.hash}`,
    );
    return EXIT.ok;
  },
};

export const CORE_COMMANDS: readonly Command[] = [
  overlayCheck,
  logVerify,
  logRestart,
  lockStatus,
  lockBreak,
];
