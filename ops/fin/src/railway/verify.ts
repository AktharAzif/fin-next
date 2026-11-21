// `pnpm fin railway verify <env>` (spec 01 §6.8; [P-13]): Railway staging, provisioned by hand
// against spec 01 §6's checklist, read back and compared row by row: every service exists, has no
// public domain and no TCP proxy, runs in the region with its replicas, restart policy, health check,
// overlap and draining, has app sleeping and outbound IPv6 off, runs an image by digest from the
// release repository (and the digest the last registered deploy recorded), keeps every secret
// sealed, and has static egress exactly where §6.5 says, with the overlay's addresses. Read-only:
// it registers no run. Exit 1 on any drift; what it could not read is listed, never passed.

import { railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { EXIT } from "../core/errors.ts";
import { type Finding, findings, inspectRailway } from "./inspect.ts";

/** The digests the last successful registered `railway deploy` recorded, by service. */
export function lastDeployed(ctx: Context): Record<string, string> {
  const done = ctx.log
    .records()
    .filter((r) => r.event === "run.done" && r.command === "railway deploy" && r.result === "ok")
    .at(-1);
  const digests = done?.running;
  return typeof digests === "object" && digests !== null ? (digests as Record<string, string>) : {};
}

export const railwayVerify: Command = {
  words: ["railway", "verify"],
  summary: "compare Railway staging with spec 01 §6's checklist and report every drift",
  positionals: [],
  flags: [],
  overlay: true,
  mutating: false,
  runbook: "railway-deploy.md",
  async run(ctx) {
    const rw = railway(ctx);
    const inspection = await inspectRailway(ctx, rw);
    const found: Finding[] = findings(ctx, inspection);
    for (const [service, image] of Object.entries(lastDeployed(ctx))) {
      const running = inspection.instances.get(service)?.image;
      if (running !== undefined && running !== image) {
        found.push({
          service,
          check: "digest",
          detail: "runs a digest other than the last registered deploy's",
        });
      }
    }
    ctx.out.info(`railway ${ctx.environment}: ${inspection.instances.size} service(s) read`);
    for (const f of found) ctx.out.info(`  ! ${f.service} ${f.check}: ${f.detail}`);
    for (const n of inspection.notChecked) ctx.out.info(`  ? not checked: ${n}`);
    ctx.out.info(
      found.length === 0 ? "railway verify: no drift" : `railway verify: ${found.length} drift(s)`,
    );
    ctx.run.line("railway.verify", found.length === 0 ? "info" : "warn", {
      drift: found.length,
      checks: found.map((f) => `${f.service}:${f.check}`),
    });
    return found.length === 0 ? EXIT.ok : EXIT.drift;
  },
};
