import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import type { CatalogEntry } from "../catalog/types.ts";
import { checkMonitoring, PHASE0_EVENTS } from "../src/check.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A copy of the staging files, the watcher's settings and the runbooks, to plant one fault in. */
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "fin-monitoring-check-"));
  roots.push(root);
  cpSync(join(ROOT, "ops", "monitoring", "staging"), join(root, "ops", "monitoring", "staging"), {
    recursive: true,
  });
  cpSync(join(ROOT, "ops", "watcher", "settings"), join(root, "ops", "watcher", "settings"), {
    recursive: true,
  });
  cpSync(join(ROOT, "docs", "runbooks"), join(root, "docs", "runbooks"), { recursive: true });
  return root;
}

function edit(root: string, file: string, change: (json: Record<string, unknown>) => void): void {
  const path = join(root, "ops", "monitoring", "staging", file);
  const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  change(json);
  writeFileSync(path, JSON.stringify(json));
}

type Json = Record<string, unknown>;
const alerts = (json: Json) => json.alerts as Json[];
const alert = (json: Json, name: string) => alerts(json).find((a) => a.name === name) as Json;

const CANNOT = "writes a name MC-01 cannot read: write the event's name as a literal";
const OUT_OF_SHAPE =
  "writes a name out of the event-name shape: write <area>.<name> in lower case (any other ships as telemetry.bad_event)";
const UNLEXED = (why: string) =>
  `the lexer cannot read the file from here (${why}), so MC-01 reads none of its writer calls: a misread could hide one`;

function rules(root: string, options: Parameters<typeof checkMonitoring>[1] = {}): string[] {
  return checkMonitoring(root, { scanCode: false, scan: [], ...options }).map(
    (f) => `${f.rule} ${f.message}`,
  );
}

describe("monitoring:check on the repository", () => {
  it("passes, in well under a second", () => {
    const started = performance.now();
    expect(checkMonitoring(ROOT)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("catalogues every event spec 01 §8.9 lists", () => {
    const events = new Set(Object.values(fragments).flatMap((f) => f.map((e) => e.event)));
    for (const event of PHASE0_EVENTS) expect(events.has(event), event).toBe(true);
  });

  it("passes on the scratch copy (the planted cases below start clean)", () => {
    expect(rules(scratch())).toEqual([]);
  });
});

describe("monitoring:check refuses", () => {
  it("an alert whose runbook does not exist (MC-08)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      (alert(j, "process-crash").metadata as Json).runbook = "docs/runbooks/missing.md";
    });
    expect(rules(root)).toContainEqual(
      "MC-08 process-crash: its runbook docs/runbooks/missing.md does not exist",
    );
  });

  it("an alert without incident_cause or a flow ID (MC-08)", () => {
    const root = scratch();
    edit(root, "alerts/email.json", (j) => {
      delete alert(j, "email-not-sent").incident_cause;
      (alert(j, "email-not-sent").metadata as Json).flow = "email";
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-08 email-not-sent: has no incident_cause");
    expect(found).toContainEqual("MC-08 email-not-sent: metadata.flow email is not a flow ID");
  });

  it("a staging alert routed to a production policy or any other policy (MC-13, RT-01)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "process-crash").policy = "production-page";
      alert(j, "shutdown-forced").policy = "loud";
      delete alert(j, "dns-lookup-failing").policy;
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-13 process-crash: routes to production-page");
    expect(found).toContainEqual("RT-01 shutdown-forced: routes to loud");
    expect(found).toContainEqual("RT-01 dns-lookup-failing: has no policy");
  });

  it("a staging object that calls, texts or pushes (RT-03)", () => {
    const root = scratch();
    edit(root, "monitors.json", (j) => {
      ((j.monitors as Json[])[0] as Json).notify = { sms: true };
    });
    edit(root, "heartbeats.json", (j) => {
      (j.defaults as Json).notify = { email: true, push: true };
    });
    edit(root, "alerts/database.json", (j) => {
      alert(j, "grants-drift").call = true;
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "RT-03 monitor api-health asks for sms: staging stays quiet (email only)",
    );
    expect(found).toContainEqual(
      "RT-03 heartbeat watcher asks for push: staging stays quiet (email only)",
    );
    expect(found).toContainEqual("RT-03 grants-drift: asks for call: staging stays quiet");
  });

  it("a staging-quiet that is not email only, escalates, or has an ai_sre member (RT-02, RT-03)", () => {
    const root = scratch();
    edit(root, "policies.json", (j) => {
      ((j.severities as Json[])[0] as Json).critical_alert = true;
      const policy = (j.policies as Json[])[0] as Json;
      policy.repeatCount = 2;
      ((policy.steps as Json[])[0] as Json).members = [{ type: "ai_sre" }];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "RT-03 severity quiet asks for critical_alert: staging stays quiet (email only)",
    );
    expect(found).toContainEqual("RT-02 staging-quiet escalates or repeats");
    expect(found).toContainEqual("RT-02 staging-quiet has an ai_sre member");
  });

  it("a watcher alert that does not open one incident per check, target and detail (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "cloudflare-config-changed").seriesBy = "target";
      delete alert(j, "tunnel-connectors").seriesBy;
    });
    edit(root, "alerts/email.json", (j) => {
      alert(j, "email-setting-changed").seriesBy = ["target", "detail"];
    });
    const found = rules(root).filter((f) => f.includes("groups watcher.check_failed"));
    const why = "so a failure that stands never hides a later, different one";
    // The fragments are read in name order: email.json before platform.json.
    expect(found).toEqual([
      `MC-04 email-setting-changed: groups watcher.check_failed by target, detail, not by check, target, detail, ${why}`,
      `MC-04 tunnel-connectors: groups watcher.check_failed by nothing, not by check, target, detail, ${why}`,
      `MC-04 cloudflare-config-changed: groups watcher.check_failed by target, not by check, target, detail, ${why}`,
    ]);
  });

  it("a staging-quiet whose step waits, or reaches anyone but the entire staging team (RT-02)", () => {
    const cases: [string, Json, string][] = [
      [
        "no member",
        { members: [] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "a webhook",
        { members: [{ type: "all_webhook_integrations" }, { type: "all_slack_integrations" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "the on-call",
        { members: [{ type: "current_on_call" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "the team and one more",
        { members: [{ type: "entire_team" }, { type: "all_webhook_integrations" }] },
        "RT-02 staging-quiet: its step must reach the entire staging team and no one else",
      ],
      [
        "a wait",
        { waitBefore: 315360000 },
        "RT-02 staging-quiet: its step must notify at once (waitBefore 0)",
      ],
    ];
    for (const [what, change, expected] of cases) {
      const root = scratch();
      edit(root, "policies.json", (j) => {
        const step = (((j.policies as Json[])[0] as Json).steps as Json[])[0] as Json;
        Object.assign(step, change);
      });
      expect(rules(root), what).toEqual([expected]);
    }
  });

  it("a literal threshold, window or grace (MC-11)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "dns-lookup-failing").threshold = 500;
      alert(j, "no-logs-{service}").window = "300";
    });
    edit(root, "heartbeats.json", (j) => {
      ((j.heartbeats as Json[])[0] as Json).grace = 30;
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-11 dns-lookup-failing: threshold must be @any, @none or an @thresholds.<key> overlay key",
    );
    expect(found).toContainEqual(
      "MC-11 no-logs-edge: window must be an @thresholds.<key> overlay key",
    );
    expect(found).toContainEqual(
      "MC-11 heartbeat watcher: grace must be an @grace.<key> overlay key",
    );
  });

  it("an alert name used twice (MC-14)", () => {
    const root = scratch();
    edit(root, "alerts/email.json", (j) => {
      alerts(j).push({ ...alert(j, "email-not-sent") });
    });
    expect(rules(root).some((r) => r.startsWith("MC-14 email-not-sent is also defined in"))).toBe(
      true,
    );
  });

  it("an alert reading an event or a field the catalogue does not declare (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "process-crash").query = { count: { events: ["made.up"] } };
      alert(j, "csp-reports").query = {
        count: { events: ["csp.report"], where: [{ field: "email", eq: "x" }] },
      };
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-04 process-crash: reads the event made.up, which is not catalogued",
    );
    expect(found).toContainEqual(
      "MC-04 csp-reports: reads the field email, which no watched event declares",
    );
  });

  it("an alert the catalogue does not point back at, and a catalogue alert nobody defines (MC-04)", () => {
    const root = scratch();
    const platform = (fragments.platform ?? []).map((e) =>
      e.event === "csp.report" ? { ...e, alerts: ["csp-reports-renamed"] } : e,
    );
    const found = rules(root, { fragments: { ...fragments, platform } });
    expect(found).toContainEqual(
      "MC-04 csp-reports: watches csp.report, whose catalogue entry does not name csp-reports",
    );
    expect(found).toContainEqual(
      "MC-04 csp.report names the alert csp-reports-renamed, which no staging fragment defines",
    );
  });

  it("a failure event with no alert and no reason, and a missing Phase 0 event (MC-02, MC-01)", () => {
    const root = scratch();
    const extra: CatalogEntry = {
      event: "thing.failed",
      kind: "failure",
      level: "error",
      fields: {},
      alerts: [],
      writtenBy: "test",
    };
    const platform = [
      ...(fragments.platform ?? []).filter((e) => e.event !== "dns.lookup_failed"),
      extra,
    ];
    const found = rules(root, { fragments: { ...fragments, platform } });
    expect(found).toContainEqual(
      "MC-02 thing.failed is failure with no alert and no noAlert reason",
    );
    expect(found).toContainEqual("MC-01 spec 01 §8.9's event dns.lookup_failed is not catalogued");
  });

  it("an event written in code that is not catalogued (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "apps", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "apps", "edge", "src", "a.ts"),
      'log("edge.surprise", {});\nlog("request", {});\n',
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 log("edge.surprise") is not catalogued',
    ]);
  });

  it("an event any telemetry writer writes, in every style the code uses (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        'rt.lines.write("edge.lines", "warn", { realm });',
        "this.options.telemetry.logUnit(",
        '  "edge.unit",',
        "  { errorCode },",
        '  "error",',
        ");",
        'telemetry.logLocal("edge.local", { text });',
        'ctx.run.line("edge.run", "info", { drift: 0 });',
        'this.line("edge.this_line", "info", {});',
        'this.#line("edge.private", "info", {});',
        'this.format("edge.format", { status }, "warn");',
        "tx.context.log.write({",
        '  level: "warn",',
        '  fields: { event: "user.created" },',
        '  event: "edge.object",',
        "});",
        'this.o.log?.log("edge.optional", {});',
        "write(`${JSON.stringify(scrubLine({",
        '  message: "edge.raw",',
        '  event: "edge.raw",',
        "}))}\\n`);",
        'log(JSON.stringify({ event: "edge.static", release }));',
        'out.write("edge.any_receiver");',
        'lines.write("request", "info", {});',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.lines") is not catalogued',
      'MC-01 telemetry.logUnit("edge.unit") is not catalogued',
      'MC-01 telemetry.logLocal("edge.local") is not catalogued',
      'MC-01 run.line("edge.run") is not catalogued',
      'MC-01 this.line("edge.this_line") is not catalogued',
      'MC-01 this.#line("edge.private") is not catalogued',
      'MC-01 this.format("edge.format") is not catalogued',
      'MC-01 log.write({ event: "edge.object" }) is not catalogued',
      'MC-01 log.log("edge.optional") is not catalogued',
      'MC-01 out.write("edge.any_receiver") is not catalogued',
      'MC-01 JSON.stringify({ event: "edge.raw" }) is not catalogued',
      'MC-01 JSON.stringify({ event: "edge.static" }) is not catalogued',
    ]);
    const files = checkMonitoring(root, { scan: [] }).map((f) => f.file);
    expect(files[0]).toBe("packages/edge/src/a.ts:1");
    expect(files[1]).toBe("packages/edge/src/a.ts:2");
  });

  it("a name a telemetry writer is passed in a variable, read from its declaration (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        "export function set(deps: Deps, input: { state: string }) {",
        '  const event = input.state === "on" ? "edge.set" : "edge.cleared";',
        '  deps.lines.write(event, "warn", { reason });',
        "}",
        "function guard(context: Context, table: string): void {",
        '  const line: Line = { event: "edge.guard", level: "error", fields: { table } };',
        "  context.log.write(line);",
        "}",
        'const one = "request";',
        'lines.write(one, "info", {});',
        'lines.write(on ? "edge.inline_on" : "edge.inline_off", "info", {});',
        'o.log?.("edge.optional_call", {});',
        'for (const each of ["edge.loop_a", "edge.loop_b"]) lines.write(each, "info", {});',
        // A module constant declared below the function that writes it.
        "function late(deps: Deps) {",
        '  deps.lines.write(LATE, "warn", {});',
        "}",
        'const LATE = "edge.late";',
        // A receiver with a non-null assertion, and an object's `event` in shorthand.
        "function bang(deps: Deps) {",
        '  const name = "edge.bang";',
        '  deps.lines!.write(name, "warn", {});',
        "}",
        "function shorthand(context: Context) {",
        '  const event = "edge.shorthand";',
        '  context.log.write({ event, level: "warn", fields: {} });',
        "}",
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write(event: "edge.set") is not catalogued',
      'MC-01 lines.write(event: "edge.cleared") is not catalogued',
      'MC-01 log.write(line: "edge.guard") is not catalogued',
      'MC-01 lines.write(on ? "edge.inline_on" : "edge.inline_off": "edge.inline_on") is not catalogued',
      'MC-01 lines.write(on ? "edge.inline_on" : "edge.inline_off": "edge.inline_off") is not catalogued',
      'MC-01 o.log("edge.optional_call") is not catalogued',
      'MC-01 lines.write(each: "edge.loop_a") is not catalogued',
      'MC-01 lines.write(each: "edge.loop_b") is not catalogued',
      'MC-01 lines.write(LATE: "edge.late") is not catalogued',
      'MC-01 lines.write(name: "edge.bang") is not catalogued',
      'MC-01 log.write({ event: "edge.shorthand" }) is not catalogued',
    ]);
  });

  it("every shape of a name MC-01 cannot read is a finding, never a skip or a part read (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        'import { SWITCH_SET } from "./events.ts";',
        'import * as names from "./names.ts";',
        // A `let` assigned again after its declaration.
        "function reassigned(deps: Deps, failed: boolean) {",
        '  let event = "edge.ok";',
        '  if (failed) event = "edge.failed";',
        '  deps.lines.write(event, "warn", {});',
        "}",
        // A destructured loop, and a `for … in`.
        'for (const [pair, level] of [["edge.pair_a", "warn"]]) lines.write(pair, level, {});',
        'for (const key in NAMES) lines.write(key, "warn", {});',
        // Imported names.
        'lines.write(SWITCH_SET, "warn", {});',
        'lines.write(names.failed, "warn", {});',
        // A class field, read through `this`.
        "class Probe {",
        '  readonly event = "edge.field";',
        "  run(deps: Deps) {",
        '    deps.lines.write(this.event, "warn", {});',
        "  }",
        "}",
        // A literal beside something that is not one: a ternary, `??`, a join.
        'const either = failed ? "edge.failed" : okEvent;',
        'lines.write(either, "warn", {});',
        'lines.write(ok ? "edge.inline_ok" : other, "warn", {});',
        'lines.write(name ?? "edge.default", "warn", {});',
        'lines.write("edge.sign_in" + (failed ? "_failed" : ""), "warn", {});',
        // Dotted strings that are not in the event-name shape.
        'lines.write("edge.sign-in", "warn", {});',
        'lines.write("edge.Failed", "warn", {});',
        // A member other than `event`.
        'const pair2 = { event: "edge.first", alt: "edge.second" };',
        'lines.write(pair2.alt, "warn", {});',
        // A helper's parameter, a callback's, and one with a default.
        "function note(deps: Deps, event: string) {",
        '  deps.lines.write(event, "warn", {});',
        "}",
        'run().catch((reason) => lines.write(reason, "error", {}));',
        'function fallback(deps: Deps, event = "edge.default_param") {',
        '  deps.lines.write(event, "warn", {});',
        "}",
        // An object whose `event` changes after it is declared, and a spread after the key.
        "function mutated(context: Context) {",
        '  const line: Line = { event: "csrf.refused", level: "warn", fields: {} };',
        '  line.event = "edge.mutated";',
        "  context.log.write(line);",
        "}",
        'context.log.write({ event: "csrf.refused", level: "error", fields: {}, ...override });',
        // A call that holds a literal; a comment is no declaration.
        "function held(deps: Deps) {",
        '  const event = pick(kind, "csrf.refused");',
        '  deps.lines.write(event, "warn", {});',
        "}",
        "function commented(deps: Deps) {",
        "  const event = nameOf(kind);",
        '  // was: const event = "csrf.refused";',
        '  deps.lines.write(event, "warn", {});',
        "}",
        // Another function's declaration does not bind this one's parameter.
        "function one() {",
        '  const event = "request";',
        "}",
        "function two(deps: Deps, event: string) {",
        '  deps.lines.write(event, "warn", {});',
        "}",
        // A name the file never binds.
        'lines.write(nowhere, "warn", {});',
      ].join("\n"),
    );
    const cannot = "writes a name MC-01 cannot read: write the event's name as a literal";
    expect(rules(root, { scanCode: true })).toEqual([
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 lines.write(pair) ${cannot}`,
      `MC-01 lines.write(key) ${cannot}`,
      `MC-01 lines.write(SWITCH_SET) ${cannot}`,
      `MC-01 lines.write(names.failed) ${cannot}`,
      `MC-01 lines.write(this.event) ${cannot}`,
      `MC-01 lines.write(either) ${cannot}`,
      `MC-01 lines.write(ok ? "edge.inline_ok" : other) ${cannot}`,
      `MC-01 lines.write(name ?? "edge.default") ${cannot}`,
      `MC-01 lines.write("edge.sign_in" + (failed ? "_failed" : "")) ${cannot}`,
      `MC-01 lines.write("edge.sign-in") ${OUT_OF_SHAPE}`,
      `MC-01 lines.write("edge.Failed") ${OUT_OF_SHAPE}`,
      `MC-01 lines.write(pair2.alt) ${cannot}`,
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 lines.write(reason) ${cannot}`,
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 log.write(line) ${cannot}`,
      `MC-01 log.write({ event: "csrf.refused", level: "error", fields: {}, ...o…) ${cannot}`,
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 lines.write(event) ${cannot}`,
      `MC-01 lines.write(nowhere) ${cannot}`,
    ]);
  });

  it("a name a telemetry writer is passed that it cannot read, but no parameter (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // A template literal that builds the name: `edge.${kind}`.
        "const built = `edge.$" + "{kind}`;",
        'lines.write(built, "warn", {});',
        'lines.write(nameOf(kind), "warn", {});',
        "log.write({ ...line, level });",
        // Names built from a string: `edge.${kind}` in place, and a prefix joined to the rest.
        "lines.write(`edge.$" + '{kind}`, "warn", {});',
        'lines.write("edge." + kind, "warn", {});',
        // Declared with no value to read: assigned later, or destructured.
        "let later: string;",
        'later = "edge.later";',
        'lines.write(later, "warn", {});',
        "const { event: picked } = pick();",
        'lines.write(picked, "warn", {});',
        // Messages, not names.
        "log(`static: $" + "{count} deployment(s) checked`);",
        'this.line("warning: ", text);',
        "export function sink(telemetry: Telemetry): LineSink {",
        "  return { write: (line) => telemetry.log(line.event, line.fields, line.level) };",
        "}",
        "const adapter = {",
        "  write: (event, level, fields) => ctx.telemetry.log(event, fields, level),",
        "};",
        "interface Lines {",
        "  write(event: string, level: Level, fields?: Fields): void;",
        "  log(",
        "    event: string,",
        "  ): void;",
        "}",
        'this.line("", text);',
        // Messages joined to more, a call in a comment or a string, and adapters' methods.
        'this.line("warning: " + text);',
        'log("count: " + count + ".");',
        '// lines.write(event, "warn", {});',
        'const doc = "lines.write(event)";',
        "class Sink {",
        "  write(event: string, level: Level, fields: Fields) {",
        "    this.format(event, fields, level);",
        "  }",
        "}",
        "const untyped = {",
        "  write(event, level, fields) {",
        "    telemetry.log(event, fields, level);",
        "  },",
        "};",
      ].join("\n"),
    );
    const cannot = "writes a name MC-01 cannot read: write the event's name as a literal";
    expect(rules(root, { scanCode: true })).toEqual([
      `MC-01 lines.write(built) ${cannot}`,
      `MC-01 lines.write(nameOf(kind)) ${cannot}`,
      `MC-01 log.write({ ...line, level }) ${cannot}`,
      `MC-01 lines.write(\`edge.$\{kind}\`) ${cannot}`,
      `MC-01 lines.write("edge." + kind) ${cannot}`,
      `MC-01 lines.write(later) ${cannot}`,
      `MC-01 lines.write(picked) ${cannot}`,
    ]);
  });

  it("a regular expression after an arrow, a block, a postfix operator or a control head hides no writer call (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "s7.ts"),
      [
        // A regular expression that starts a statement after a block's `}`.
        "export function fence(deps: Deps, line: string): boolean {",
        '  if (line === "") {',
        "    return false;",
        "  }",
        '  /^```/.test(line) || deps.lines.write("edge.no_fence", "warn", {});',
        '  deps.lines.write("edge.after_block_regex", "warn", {});',
        "  return true; // a fence is three ` marks",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "packages", "edge", "src", "row.tsx"),
      [
        // JSX's `{x} />` closes a tag: the `/` after its `}` starts no regular expression.
        "export const Row = ({ count }: Props) => <Cell value={count} />;",
        'lines.write("edge.after_jsx", "warn", {});',
        "export const Bare = ({ count }: Props) => <Cell value={count}/>;",
        'lines.write("edge.after_bare_jsx", "warn", {});',
      ].join("\n"),
    );
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // A regular expression after `=>` holding a backtick, a quote, `\/*` or a fence.
        "const hasTick = (s: string) => /`/.test(s);",
        "function after(deps: Deps) {",
        '  deps.lines.write("edge.after_tick", "warn", {});',
        "}",
        'const EV = "edge.after_tick_const";',
        'lines.write(EV, "warn", {});',
        'const quote = (s: string) => /"/.test(s); lines.write("edge.same_line", "warn", {}); const t = "x";',
        "const bare = (path: string) => /^\\/*$/.test(path);",
        'lines.write("edge.after_comment_open", "warn", {});',
        'const fences = text.split("\\n").filter((row) => /^```/.test(row));',
        'lines.write("edge.after_fence", "warn", {});',
        // A division after a postfix `++` or `!`; a regular expression after an `if` head.
        'const half = i++ / 2; lines.write("edge.after_postfix", "warn", {}); const third = half / 3;',
        'const ratio = value! / 2; lines.write("edge.after_bang", "warn", {}); const r = ratio / 3;',
        "if (ready) /`/.test(text);",
        'lines.write("edge.after_head", "warn", {});',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.after_tick") is not catalogued',
      'MC-01 lines.write(EV: "edge.after_tick_const") is not catalogued',
      'MC-01 lines.write("edge.same_line") is not catalogued',
      'MC-01 lines.write("edge.after_comment_open") is not catalogued',
      'MC-01 lines.write("edge.after_fence") is not catalogued',
      'MC-01 lines.write("edge.after_postfix") is not catalogued',
      'MC-01 lines.write("edge.after_bang") is not catalogued',
      'MC-01 lines.write("edge.after_head") is not catalogued',
      'MC-01 lines.write("edge.after_jsx") is not catalogued',
      'MC-01 lines.write("edge.after_bare_jsx") is not catalogued',
      'MC-01 lines.write("edge.no_fence") is not catalogued',
      'MC-01 lines.write("edge.after_block_regex") is not catalogued',
    ]);
  });

  it("a division after a member named as a keyword, or after `of`, hides no writer call and refuses no file (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // Read as a regular expression, `/ stats.out … // too` would close on its line and pair
        // its brackets, and hide the call between.
        "function skew(stats: Stats) {",
        '  return stats.in / stats.out > 2 ? lines.write("edge.skew_failed", "error", {}) : undefined; // too much inbound',
        "}",
        // An honest single division would leave a regular expression open on its line.
        "const ratio = stats.in / stats.out;",
        'lines.write("edge.after_member_division", "info", { ratio });',
        'counts.new / counts.total > 0.5 ? note(telemetry.log("edge.surge", {}, "error")) : counts.old / counts.total;',
        'const share = this.#delete / 2; lines.write("edge.after_private", "warn", {}); const q = share / 3;',
        'const left = diff?.void / 2; lines.write("edge.after_optional", "warn", {}); const p = left / 3;',
        "io.in / io.out > LIMIT && run.line(`deploy.$" +
          '{kind}_failed`, "error", {}); // more in than out',
        // `of` is an identifier outside a `for` head, and a keyword in one.
        'of / total > 1 ? fail(lines.write("edge.over", "error", {})) : of / total;',
        "for (const m of /`/g.exec(text) ?? []) count++;",
        'lines.write("edge.after_for_of", "warn", {});',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.skew_failed") is not catalogued',
      'MC-01 lines.write("edge.after_member_division") is not catalogued',
      'MC-01 telemetry.log("edge.surge") is not catalogued',
      'MC-01 lines.write("edge.after_private") is not catalogued',
      'MC-01 lines.write("edge.after_optional") is not catalogued',
      'MC-01 lines.write("edge.over") is not catalogued',
      'MC-01 lines.write("edge.after_for_of") is not catalogued',
      `MC-01 run.line(\`deploy.$\{kind}_failed\`) ${CANNOT}`,
    ]);
  });

  it("a file the lexer cannot read is a finding that names it, never a skip (MC-01)", () => {
    const root = scratch();
    const dir = join(root, "packages", "edge", "src");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string[]> = {
      // A template that never closes: read as one, it would blank every call after it.
      "a.ts": [
        'lines.write("edge.before", "warn", {});',
        "const open = `never closed;",
        'lines.write("edge.hidden", "warn", {});',
      ],
      "b.ts": [
        'lines.write("edge.b", "warn", {});',
        "/* never closed",
        'lines.write("edge.b_hidden", "warn", {});',
      ],
      "c.ts": ['const s = "never closed;', 'lines.write("edge.c", "warn", {});'],
      "d.ts": ["const r = ok ? /never closed : other;", 'lines.write("edge.d", "warn", {});'],
      // Misreads the lexer cannot see itself: the brackets of the code it kept do not pair.
      "e.ts": ["function f(deps: Deps) {", '  deps.lines.write("edge.e", "warn", {});'],
      "f.ts": ['lines.write("edge.f", "warn", {}));'],
      "g.ts": ['lines.write("edge.g", ["warn", {});'],
    };
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.join("\n"));
    }
    const found = checkMonitoring(root, { scan: [] }).map(
      (f) => `${f.file} ${f.rule} ${f.message}`,
    );
    expect(found).toEqual([
      `packages/edge/src/a.ts:2 MC-01 ${UNLEXED("a template literal never closes")}`,
      `packages/edge/src/b.ts:2 MC-01 ${UNLEXED("a block comment never closes")}`,
      `packages/edge/src/c.ts:1 MC-01 ${UNLEXED("a string does not close on its line")}`,
      `packages/edge/src/d.ts:1 MC-01 ${UNLEXED("a regular expression does not close on its line")}`,
      `packages/edge/src/e.ts:1 MC-01 ${UNLEXED("a `{` never closes")}`,
      `packages/edge/src/f.ts:1 MC-01 ${UNLEXED("a `)` closes no bracket")}`,
      `packages/edge/src/g.ts:1 MC-01 ${UNLEXED("a `)` closes the `[` of line 1")}`,
    ]);
  });

  it("a name out of the event-name shape, or a message through a member call, is a finding (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // Each ships as telemetry.bad_event, which no alert watches.
        'deps.lines.write("step-up-locked", "error", { realm });',
        'run.line("deployFailed", "error", { step });',
        'telemetry.log("Access keys unavailable", {}, "error");',
        'const event = "auditGuard";',
        'telemetry.log(event, {}, "error");',
        'const message = "sign in failed";',
        'deps.lines.write(message, "error", {});',
        'log.write({ event: "sign in failed", level: "warn", fields: {} });',
        'log("Done");',
        // A template's `${…}` ends at its own brace: no space outside it, so no message.
        "lines.write(`auth.$" + '{pick({ a: 1 }, kind)}`, "warn", {});',
        "this.line(`auth.$" + '{pick({ a: 1 }, kind)}`, "warn", {});',
        // Messages through `this` or a bare call give no name and no finding.
        'this.line("warning: ", text);',
        'this.#line("", text);',
        "log(`static: $" + "{count} deployment(s) checked`);",
        'log("count: " + count + ".");',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      `MC-01 lines.write("step-up-locked") ${OUT_OF_SHAPE}`,
      `MC-01 run.line("deployFailed") ${OUT_OF_SHAPE}`,
      `MC-01 telemetry.log("Access keys unavailable") ${OUT_OF_SHAPE}`,
      `MC-01 telemetry.log(event) ${OUT_OF_SHAPE}`,
      `MC-01 lines.write(message) ${OUT_OF_SHAPE}`,
      `MC-01 log.write({ event: "sign in failed", level: "warn", fields: {} }) ${OUT_OF_SHAPE}`,
      `MC-01 log("Done") ${OUT_OF_SHAPE}`,
      `MC-01 lines.write(\`auth.$\{pick({ a: 1 }, kind)}\`) ${CANNOT}`,
      `MC-01 this.line(\`auth.$\{pick({ a: 1 }, kind)}\`) ${CANNOT}`,
    ]);
  });

  it("an adapter the file declares is read whatever the receiver, and any writer's strings whole (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // Adapters this file declares, called bare or through another receiver.
        'const line = (event: string, fields: object) => run.line(event, "error", fields);',
        'line(failed ? "edge.line_failed" : "edge.line_done", { step });',
        'const write = (event: string, fields: Fields) => telemetry.log(event, fields, "error");',
        "write(`auth.$" + "{kind}_refused`, {});",
        'const sink = { format: (event: string) => lines.write(event, "error", {}) };',
        "sink.format(pickName());",
        // An adapter of an adapter.
        "const note = { log: (event: string) => line(event, {}) };",
        "note.log(kind);",
        // A writer method's first parameter forwards only whole, or as a line's `.event`.
        "export function format(error: FinError, telemetry: Telemetry): string {",
        '  telemetry.log(error.code, {}, "error");',
        "  return error.message;",
        "}",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "packages", "edge", "src", "b.ts"),
      [
        // No adapter here: a writer under another name counts each whole string it is passed.
        "const { logUnit } = telemetry;",
        'logUnit(failed ? "edge.unit_failed" : "edge.unit_ok", {}, "error");',
        'out.write(quiet ? "edge.quiet" : "edge.loud");',
        'out.format("edge.first" || "edge.second");',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 line(failed ? "edge.line_failed" : "edge.line_done": "edge.line_failed") is not catalogued',
      'MC-01 line(failed ? "edge.line_failed" : "edge.line_done": "edge.line_done") is not catalogued',
      'MC-01 logUnit(failed ? "edge.unit_failed" : "edge.unit_ok": "edge.unit_failed") is not catalogued',
      'MC-01 logUnit(failed ? "edge.unit_failed" : "edge.unit_ok": "edge.unit_ok") is not catalogued',
      'MC-01 out.write(quiet ? "edge.quiet" : "edge.loud": "edge.quiet") is not catalogued',
      'MC-01 out.write(quiet ? "edge.quiet" : "edge.loud": "edge.loud") is not catalogued',
      'MC-01 out.format("edge.first" || "edge.second": "edge.first") is not catalogued',
      'MC-01 out.format("edge.first" || "edge.second": "edge.second") is not catalogued',
      `MC-01 write(\`auth.$\{kind}_refused\`) ${CANNOT}`,
      `MC-01 sink.format(pickName()) ${CANNOT}`,
      `MC-01 note.log(kind) ${CANNOT}`,
      `MC-01 telemetry.log(error.code) ${CANNOT}`,
    ]);
  });

  it("drops a one-word name only when no telemetry writer writes it (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "ops", "fin", "src"), { recursive: true });
    writeFileSync(
      join(root, "ops", "fin", "src", "a.ts"),
      [
        'write("stdout", text);',
        'write("stderr", FATAL);',
        'const css = `  src: url("./fonts/a.woff2") format("woff2");`;',
        'process.stdout.write("done");',
        '// each row is the line ("l" or "r")',
        'await recordAudit(tx, { event: "edge.audit", target });',
        'lines.write("surprise", "warn", {});',
        'log("oneword", {});',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("surprise") is not catalogued',
      'MC-01 log("oneword") is not catalogued',
    ]);
  });

  it("an ID-shaped metric label (MC-06)", () => {
    const root = scratch();
    edit(root, "metrics.json", (j) => {
      ((j.sets as Json).common as Json[]).push({
        name: "org",
        field: "orgId",
        type: "string_low_cardinality",
        aggregations: [],
      });
    });
    expect(rules(root)).toContainEqual(
      "MC-06 common.org: the label orgId is ID-shaped or free text",
    );
  });

  it("a Better Stack identifier, ingest host or heartbeat URL in a file (MC-12)", () => {
    const root = scratch();
    edit(root, "sources.json", (j) => {
      j.note = ["s1234", "eu-nbg-2", "betterstackdata", "com"].join(".");
    });
    edit(root, "heartbeats.json", (j) => {
      j.note = "https://uptime.betterstack.com/api/v1/heartbeat/abc";
    });
    const found = rules(root);
    expect(found).toContainEqual("MC-12 holds what looks like a Better Stack ingest host");
    expect(found).toContainEqual("MC-12 holds what looks like a Better Stack heartbeat URL");
    // Each file is scanned once.
    expect(found.filter((f) => f.endsWith("ingest host"))).toHaveLength(1);
  });

  it("a runbook without a heading, or that does not name its alert (MC-10)", () => {
    const root = scratch();
    const path = join(root, "docs", "runbooks", "private-dns.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace("## Containment", "## Fixing")
        .replace("`dns-lookup-failing`", "it"),
    );
    const found = rules(root);
    expect(found).toContainEqual('MC-10 lacks the heading "## Containment"');
    expect(found).toContainEqual("MC-10 does not name dns-lookup-failing, which points at it");
  });

  it("a source with no Errors application and no reason, and an alert on an unknown source (MC-07)", () => {
    const root = scratch();
    edit(root, "errors.json", (j) => {
      delete (j.noApplication as Json).watcher;
    });
    edit(root, "alerts/platform.json", (j) => {
      alert(j, "csp-reports").sources = ["docs"];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-07 the source watcher has no Errors application and no reason",
    );
    expect(found).toContainEqual("MC-07 csp-reports: names the source docs, which does not exist");
  });

  it("a monitor naming a hostname instead of a host role (MC-00)", () => {
    const root = scratch();
    edit(root, "monitors.json", (j) => {
      ((j.monitors as Json[])[0] as Json).host = "api.example.net";
    });
    expect(rules(root)).toContainEqual(
      "MC-00 monitor api-health: host must be a host role, never a hostname",
    );
  });

  it("files that name another environment's team, name prefix or environment (MC-13)", () => {
    const root = scratch();
    edit(root, "sources.json", (j) => {
      j.team = "fin-production";
      j.namePrefix = "fin-next-production-";
    });
    edit(root, "policies.json", (j) => {
      j.team = "fin-production";
    });
    edit(root, "errors.json", (j) => {
      j.namePrefix = "fin-next-production-";
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-13 names the team fin-production; the staging files belong to fin-staging",
    );
    expect(found).toContainEqual(
      "MC-13 names the prefix fin-next-production-; the staging files use fin-next-staging-",
    );
    expect(found.filter((f) => f.startsWith("MC-13"))).toHaveLength(4);
  });

  it("a Phase 0 heartbeat, or the watcher's own, missing from heartbeats.json (MC-05)", () => {
    const root = scratch();
    edit(root, "heartbeats.json", (j) => {
      j.heartbeats = (j.heartbeats as Json[]).filter((h) => h.name === "verify-daily");
    });
    const found = rules(root);
    for (const name of [
      "watcher",
      "scheduler-worker",
      "scheduler-payments",
      "email-delivery-check",
      "backup-nightly",
      "backup-hourly",
    ]) {
      expect(found).toContainEqual(`MC-05 spec 01 §8.5's heartbeat ${name} is missing`);
    }
    const renamed = scratch();
    const settings = join(renamed, "ops", "watcher", "settings", "staging.json");
    const watcher = JSON.parse(readFileSync(settings, "utf8")) as Json;
    writeFileSync(settings, JSON.stringify({ ...watcher, heartbeat: "watcher-2" }));
    expect(rules(renamed)).toContainEqual(
      "MC-05 the watcher's settings ping the heartbeat watcher-2, which heartbeats.json does not define",
    );
  });

  it("a secret delivered to something that is not a Railway service (MC-07)", () => {
    const root = scratch();
    edit(root, "heartbeats.json", (j) => {
      ((j.heartbeats as Json[])[0] as Json).holders = ["watcher"];
    });
    edit(root, "sources.json", (j) => {
      ((j.sources as Json[]).find((s) => s.service === "ops") as Json).holders = ["ops"];
    });
    edit(root, "errors.json", (j) => {
      ((j.applications as Json[])[0] as Json).holders = ["edge", "edge-2"];
    });
    const found = rules(root);
    expect(found).toContainEqual(
      "MC-07 heartbeat watcher delivers its secret to watcher, which is not a Railway service",
    );
    expect(found).toContainEqual(
      "MC-07 source ops delivers its secret to ops, which is not a Railway service",
    );
    expect(found).toContainEqual(
      "MC-07 application edge delivers its secret to edge-2, which is not a Railway service",
    );
  });

  it("a security event filtered with eq false, which lets a line without the field through (MC-04)", () => {
    const root = scratch();
    edit(root, "alerts/database.json", (j) => {
      alert(j, "privileged-login").query = {
        count: {
          events: ["database.privileged_login"],
          where: [{ field: "registered", eq: false }],
        },
      };
    });
    expect(rules(root)).toContainEqual(
      "MC-04 privileged-login: filters the security event database.privileged_login with registered eq false, so a line without registered never alerts; use notEq true",
    );
  });

  it("a metric whose type is not one of Better Stack's (MC-00)", () => {
    const root = scratch();
    edit(root, "metrics.json", (j) => {
      ((j.sets as Json).request as Json[]).push({
        name: "bytes",
        field: "durationMs",
        type: "float",
        aggregations: ["max"],
      });
    });
    expect(rules(root)).toContainEqual(
      "MC-00 request.bytes: type float is not a Better Stack metric type",
    );
  });

  it("an identifier in any file of the environment, not only the files it parses (MC-12)", () => {
    const root = scratch();
    mkdirSync(join(root, "ops", "monitoring", "staging", "dashboards"), { recursive: true });
    const host = ["s1234", "eu-nbg-2", "betterstackdata", "com"].join(".");
    writeFileSync(
      join(root, "ops", "monitoring", "staging", "dashboards", "fin-services.json"),
      JSON.stringify({ panels: [{ query: `FROM t123456_fin_logs`, from: host }] }, null, 2),
    );
    writeFileSync(
      join(root, "ops", "monitoring", "staging", "webhooks.json"),
      `{\n  "token": "x",\n  "dsn": "https://${"a".repeat(12)}@${host}/1"\n}\n`,
    );
    const found = checkMonitoring(root, { scanCode: false, scan: [] }).filter(
      (f) => f.rule === "MC-12",
    );
    const files = new Set(found.map((f) => f.file.split(":")[0]));
    expect(files).toEqual(
      new Set([
        "ops/monitoring/staging/dashboards/fin-services.json",
        "ops/monitoring/staging/webhooks.json",
      ]),
    );
    const messages = found.map((f) => f.message);
    for (const shape of ["ingest host", "team ID", "token field", "DSN"]) {
      expect(messages).toContainEqual(`holds what looks like a Better Stack ${shape}`);
    }
  });

  it("a templated alert whose forEach does not provide a placeholder (MC-00)", () => {
    const root = scratch();
    edit(root, "alerts/platform.json", (j) => {
      (alert(j, "process-crash").metadata as Json).check = "Look at {region}.";
    });
    expect(rules(root)).toContainEqual(
      "MC-00 process-crash: an unexpanded {placeholder} remains (forEach does not provide it)",
    );
  });
});
