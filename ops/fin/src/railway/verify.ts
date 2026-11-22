// `pnpm fin railway verify <env>` (spec 01 §6.8; [P-13]): Railway staging, provisioned by hand
// against spec 01 §6's checklist, read back and compared row by row: every service exists, has no
// public domain and no TCP proxy (listed in the settings or not), no instance in another
// environment and no variable that refers to the database template (§6.3), runs in the region with
// its replicas, restart policy, health check, overlap and draining, has app sleeping and outbound
// IPv6 off and PORT=8080, runs an image by digest from the release repository (and the digest the
// registered deploys recorded for it, set as its source and run by its newest deployment, which
// ended SUCCESS), keeps every secret sealed, and has static egress exactly
// where §6.5 says, with the overlay's addresses. Read-only: it registers no run. Exit 1 on any
// drift; what it could not read is listed, never passed.

import { railway } from "../cloudflare/common.ts";
import type { Command } from "../command.ts";
import type { Context } from "../core/context.ts";
import { EXIT } from "../core/errors.ts";
import { type Finding, findings, inspectRailway } from "./inspect.ts";
import { readRunning } from "./running.ts";

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
 * Why the newest registered `railway deploy` in this machine's run log is not a successful one of
 * the release, or undefined when it is. Only the newest counts, whatever its result, and one with
 * no `run.done` (still running, or stopped) counts as not finished: a later deploy of another
 * release, or a failed one, may have moved the services off the release (spec 01 §6.9, S0-06).
 */
export function newestRailwayDeployProblem(ctx: Context, release: string): string | undefined {
  const records = ctx.log.records();
  const registered = records.filter(
    (r) => r.event === "run.registered" && r.command === "railway deploy",
  );
  const newest = registered.at(-1);
  if (newest === undefined) return "records no railway deploy";
  const done = records.find(
    (r) => r.event === "run.done" && r.runId === newest.runId && r.seq > newest.seq,
  );
  if (done === undefined) return "has a newest railway deploy that did not finish";
  if (done.result !== "ok") return "has a newest railway deploy that failed";
  const ran = [newest.release, done.release].filter((r) => r !== undefined);
  if (ran.length === 0 || ran.some((r) => r !== release))
    return "has a newest railway deploy of another release";
  return undefined;
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
    const unread: string[] = [];
    for (const [service, want] of Object.entries(ctx.settings.railway.services)) {
      if (want.template === true) continue;
      const instance = inspection.instances.get(service);
      const source = instance?.image;
      const image = expected.get(service);
      if (image === undefined) {
        if (source !== null && source !== undefined && source !== "") unrecorded.push(service);
        continue;
      }
      if (source !== image) {
        found.push({
          service,
          check: "digest",
          detail: "is set to a digest other than the one the registered deploys recorded",
        });
        continue;
      }
      // The source is what the next deployment takes; what serves is the newest deployment. A task
      // or a cron job runs to its end and serves nothing, so only its source is compared.
      if (want.task === true || want.cron !== undefined) continue;
      const running = await readRunning(ctx, rw, service, instance);
      if (running.status !== "SUCCESS") {
        found.push({
          service,
          check: "deployment",
          detail: `the newest deployment is ${running.status ?? "missing"}, not SUCCESS`,
        });
      } else if (running.image === undefined) {
        unread.push(service);
      } else if (running.image !== image) {
        found.push({
          service,
          check: "digest",
          detail:
            "the newest deployment runs a digest other than the one the registered deploys recorded",
        });
      }
    }
    if (unrecorded.length > 0)
      inspection.notChecked.push(
        `the running digest of ${unrecorded.join(", ")} (no registered deploy in this machine's run log recorded one)`,
      );
    if (unread.length > 0)
      inspection.notChecked.push(
        `the image the newest deployment of ${unread.join(", ")} runs (Railway did not say; SP-03)`,
      );
    ctx.out.info(`railway ${ctx.environment}: ${inspection.instances.size} service(s) read`);
    for (const f of found) ctx.out.info(`  ! ${f.service} ${f.check}: ${f.detail}`);
    // Not drift: a value a run overwrote with the inert one, since a delete would start a
    // deployment (rule 3); it is removed by a planned deployment that does not take it.
    for (const a of inspection.awaitingRemoval) ctx.out.info(`  waits for removal: ${a} (inert)`);
    for (const n of inspection.notChecked) ctx.out.info(`  ? not checked: ${n}`);
    ctx.out.info(
      found.length === 0 ? "railway verify: no drift" : `railway verify: ${found.length} drift(s)`,
    );
    ctx.run.line("railway.verify", found.length === 0 ? "info" : "warn", {
      drift: found.length,
      checks: found.map((f) => `${f.service}:${f.check}`),
      awaitingRemoval: inspection.awaitingRemoval,
    });
    return found.length === 0 ? EXIT.ok : EXIT.drift;
  },
};
