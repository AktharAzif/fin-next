// The core commands: checking the overlay, the run log and the run lock.

import type { Command } from "../command.ts";
import { flagString } from "../core/args.ts";
import { EXIT, UsageError } from "../core/errors.ts";
import { HOST_ROLES } from "../core/overlay.ts";

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
    ctx.out.info(`  ${ctx.masker.size} private values registered for masking`);
    return EXIT.ok;
  },
};

const logVerify: Command = {
  words: ["log", "verify"],
  summary: "check that the local run log's hash chain is intact",
  positionals: [],
  flags: [],
  overlay: false,
  mutating: false,
  runbook: "pnpm-fin.md",
  async run(ctx) {
    const problems = ctx.log.verify();
    const count = ctx.log.records().length;
    if (problems.length === 0) {
      ctx.out.info(`run log: ${count} record(s), chain intact`);
      return EXIT.ok;
    }
    for (const problem of problems) ctx.out.error(`run log: ${problem}`);
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
    const reason = flagString(ctx.args, "reason");
    if (reason === undefined || reason.trim().length < 8) {
      throw new UsageError('lock break needs --reason "<why>" (at least 8 characters)');
    }
    const broken = ctx.log.breakLock(ctx.runtime.now(), ctx.run.id, reason, ctx.runtime.operator());
    if (broken === undefined) ctx.out.info("run lock: already free");
    else ctx.out.info(`run lock: broken (it was held by ${broken.runId}, ${broken.command})`);
    return EXIT.ok;
  },
};

export const CORE_COMMANDS: readonly Command[] = [overlayCheck, logVerify, lockStatus, lockBreak];
