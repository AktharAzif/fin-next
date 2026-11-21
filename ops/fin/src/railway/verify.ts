// `pnpm fin railway verify <env>` (spec 01 §6.8; [P-13]): Railway staging, provisioned by hand
// against spec 01 §6's checklist, read back and compared row by row: every service exists, has no
// public domain and no TCP proxy (listed in the settings or not), no instance in another
// environment and no variable that refers to the database template (§6.3), runs in the region with
// its replicas, restart policy, health check, overlap and draining, has app sleeping and outbound
// IPv6 off and PORT=8080, runs an image by digest from the release repository (and the digest the
// registered deploys recorded for it), keeps every secret sealed, and has static egress exactly
// where §6.5 says, with the overlay's addresses. Read-only: it registers no run. Exit 1 on any
// drift; what it could not read is listed, never passed.

import { railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { EXIT } from "../core/errors.ts";
import { type Finding, findings, inspectRailway } from "./inspect.ts";

/**
 * The image each service should run, by service: for each one, the digest the newest successful
 * registered `railway deploy` recorded for it. A deploy records every service it rolled or kept on
 * the release, so a service missing from the newest record (migrate, when a release has no
 * migrations) keeps the digest an earlier deploy recorded.
 */
export function lastDeployed(ctx: Context): Map<string, string> {
  const expected = new Map<string, string>();
  const done = ctx.log
    .records()
    .filter((r) => r.event === "run.done" && r.command === "railway deploy" && r.result === "ok");
  for (const record of done) {
    const running = record.running;
    if (typeof running !== "object" || running === null || Array.isArray(running)) continue;
    for (const [service, image] of Object.entries(running as Record<string, unknown>)) {
      if (typeof image === "string") expected.set(service, image);
    }
  }
  return expected;
}

/**
 * Whether this machine's run log records a successful registered `railway deploy` of the release:
 * its services rolled, so its pages may follow (spec 01 §6.9, S0-06).
 */
export function railwayDeployed(ctx: Context, release: string): boolean {
  return ctx.log
    .records()
    .some(
      (r) =>
        r.event === "run.done" &&
        r.command === "railway deploy" &&
        r.result === "ok" &&
        r.release === release,
    );
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
    const expected = lastDeployed(ctx);
    const unrecorded: string[] = [];
    for (const [service, want] of Object.entries(ctx.settings.railway.services)) {
      if (want.template === true) continue;
      const running = inspection.instances.get(service)?.image;
      const image = expected.get(service);
      if (image === undefined) {
        if (running !== null && running !== undefined && running !== "") unrecorded.push(service);
        continue;
      }
      if (running !== image) {
        found.push({
          service,
          check: "digest",
          detail: "runs a digest other than the one the registered deploys recorded",
        });
      }
    }
    if (unrecorded.length > 0)
      inspection.notChecked.push(
        `the running digest of ${unrecorded.join(", ")} (no registered deploy in this machine's run log recorded one)`,
      );
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
