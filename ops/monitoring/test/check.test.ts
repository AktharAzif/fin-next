import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
const UNTOKENIZED = (column: number, reason: string) =>
  `the tokenizer cannot read the file from column ${column} of this line (${reason}), so MC-01 reads none of its writer calls: a misread could hide one`;

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

  it("a comment that ends in a full stop leaves the keyword after it a keyword, and hides no writer call (MC-01)", () => {
    const root = scratch();
    const dir = join(root, "packages", "edge", "src");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string[]> = {
      // Read as divisions, the two fences' backticks would pair as a template over the call.
      "a.ts": [
        "export function opens(line: string): boolean {",
        "  // A fence opens a code block.",
        "  return /^```/.test(line);",
        "}",
        "export function between(deps: Deps): void {",
        '  deps.lines.write("edge.between_fences", "error", {});',
        "}",
        "export function closes(line: string): boolean {",
        "  // A fence closes it.",
        "  return /^```\\s*$/.test(line);",
        "}",
      ],
      // A prefix `!` after the keyword; the comment's backtick would close the template.
      "b.ts": [
        "export function plain(text: string): boolean {",
        "  // No code marks in it.",
        "  return !/`/.test(text);",
        "}",
        "export function after(deps: Deps): void {",
        '  deps.lines.write("edge.after_bang_regex", "warn", {});',
        "  return; // a mark is a ` sign",
        "}",
      ],
      "c.ts": [
        "export function kind(deps: Deps, line: string): string {",
        "  switch (true) {",
        "    // A fence line.",
        "    case /^`/.test(line):",
        '      deps.lines.write("edge.after_case", "warn", {});',
        '      return "fence";',
        "    default:",
        '      return "text"; // not a ` line',
        "  }",
        "}",
      ],
      // Read as a division, `\/*` would open a block comment to the `*/` after the call.
      "d.ts": [
        "export function slashes(path: string): boolean {",
        "  // Whether the path is only slashes.",
        "  return /^\\/*$/.test(path);",
        "}",
        "export function after(deps: Deps): void {",
        '  deps.lines.write("edge.after_slashes", "error", {}); /* one line per unit */',
        "}",
      ],
      // Read as a division, the pattern's `//` would start a line comment over the call.
      "e.ts": [
        "export function scheme(deps: Deps, url: string): boolean {",
        "  // Only web addresses pass.",
        '  return /^https?:\\/\\//.test(url) || refuse(deps.lines.write("edge.bad_scheme", "error", {}));',
        "}",
      ],
    };
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.join("\n"));
    }
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.between_fences") is not catalogued',
      'MC-01 lines.write("edge.after_bang_regex") is not catalogued',
      'MC-01 lines.write("edge.after_case") is not catalogued',
      'MC-01 lines.write("edge.after_slashes") is not catalogued',
      'MC-01 lines.write("edge.bad_scheme") is not catalogued',
    ]);
  });

  it("a comment before a keyword, a member's name or a bracket refuses no honest file (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        // Read as a division, the quote would open a string that never closes on its line.
        "export function quoted(value: string): boolean {",
        "  // A value in quotes is a literal.",
        "  return /^['\"]/.test(value);",
        "}",
        'lines.write("edge.after_quote_regex", "warn", {});',
        // A comment that ends in `with` starts no `with` head: the `/` after `)` divides.
        "export function share(deps: Deps, used: number, pending: number, total: number): number {",
        "  const part =",
        "    // the part to compare the total with",
        "    (used + pending) / total;",
        '  deps.lines.write("edge.after_share", "info", { part });',
        "  return part;",
        "}",
        // A member's name on the line after its dot is still a member's.
        "const ratio = stats.",
        "  in / stats.out;",
        'lines.write("edge.after_split_member", "info", { ratio });',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.after_quote_regex") is not catalogued',
      'MC-01 lines.write("edge.after_share") is not catalogued',
      'MC-01 lines.write("edge.after_split_member") is not catalogued',
    ]);
  });

  it("a file the tokenizer cannot read is a finding that names it, never a skip (MC-01)", () => {
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
      // Brackets that do not pair.
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
      `packages/edge/src/a.ts:2 MC-01 ${UNTOKENIZED(14, "an unterminated template literal")}`,
      `packages/edge/src/b.ts:2 MC-01 ${UNTOKENIZED(1, "an unterminated comment")}`,
      `packages/edge/src/c.ts:1 MC-01 ${UNTOKENIZED(11, "an unterminated string")}`,
      `packages/edge/src/d.ts:1 MC-01 ${UNTOKENIZED(16, "an unterminated regular expression")}`,
      `packages/edge/src/e.ts:1 MC-01 ${UNTOKENIZED(24, 'a bracket left open (expected "}")')}`,
      `packages/edge/src/f.ts:1 MC-01 ${UNTOKENIZED(34, 'a ")" that closes nothing')}`,
      `packages/edge/src/g.ts:1 MC-01 ${UNTOKENIZED(34, 'a ")" where "]" should close what opened on line 1')}`,
    ]);
  });

  it("every refusal of the tokenizer is a finding that names the file, one with no writer call included (MC-01)", () => {
    const root = scratch();
    const dir = join(root, "packages", "edge", "src");
    mkdirSync(dir, { recursive: true });
    const files: Record<string, string[]> = {
      "h.tsx": ["export const A = () => <b>{x} > y</b>;", 'lines.write("edge.h", "warn", {});'],
      "i.tsx": ["export const B = () => <b>x</c>;"],
      "j.ts": ["const x = 1;", "<<<<<<< HEAD", 'lines.write("edge.j", "warn", {});'],
      "k.ts": ["const x = 1; <!-- y", 'lines.write("edge.k", "warn", {});'],
      "l.ts": ['lines.write("edge.\\x2", "warn", {});'],
      "m.ts": ["const a = 1\u0085;"],
      "n.ts": ["const a = 0b2;"],
      "o.ts": ["const a = /x/gg;"],
    };
    for (const [name, lines] of Object.entries(files)) {
      writeFileSync(join(dir, name), lines.join("\n"));
    }
    const found = checkMonitoring(root, { scan: [] }).map(
      (f) => `${f.file} ${f.rule} ${f.message}`,
    );
    expect(found).toEqual([
      `packages/edge/src/h.tsx:1 MC-01 ${UNTOKENIZED(31, 'a ">" in JSX text')}`,
      `packages/edge/src/i.tsx:1 MC-01 ${UNTOKENIZED(28, "a JSX closing tag </c> for <b>")}`,
      `packages/edge/src/j.ts:2 MC-01 ${UNTOKENIZED(1, "a version-control conflict marker")}`,
      `packages/edge/src/k.ts:1 MC-01 ${UNTOKENIZED(14, "an HTML-like comment, which a script and a module read differently")}`,
      `packages/edge/src/l.ts:1 MC-01 ${UNTOKENIZED(19, "an invalid \\x escape")}`,
      `packages/edge/src/m.ts:1 MC-01 ${UNTOKENIZED(12, "a character that cannot stand in code (U+0085)")}`,
      `packages/edge/src/n.ts:1 MC-01 ${UNTOKENIZED(11, "a numeric literal with no digits")}`,
      `packages/edge/src/o.ts:1 MC-01 ${UNTOKENIZED(11, "a regular expression with an invalid flag")}`,
    ]);
  });

  it("a writer's name, a string and a template are read as their values, escapes decoded (MC-01)", () => {
    const root = scratch();
    mkdirSync(join(root, "packages", "edge", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "edge", "src", "a.ts"),
      [
        'lin\\u0065s.wr\\u0069te("edge\\x2eescaped_name", "warn", {});',
        'telemetry.log(`edge.\\u{74}emplate`, {}, "error");',
        'log.write({ \'ev\\u0065nt\': "edge.escaped_key", level: "warn" });',
        // A message's escaped newline is white space: through a member call, a finding.
        'lines.write("edge\\nsplit", "warn", {});',
        'process.stdout.write(JSON.stringify({ "event": "edge.raw\\u005fescaped" }));',
      ].join("\n"),
    );
    expect(rules(root, { scanCode: true })).toEqual([
      'MC-01 lines.write("edge.escaped_name") is not catalogued',
      'MC-01 telemetry.log("edge.template") is not catalogued',
      'MC-01 log.write({ event: "edge.escaped_key" }) is not catalogued',
      'MC-01 JSON.stringify({ event: "edge.raw_escaped" }) is not catalogued',
      `MC-01 lines.write("edge\\nsplit") ${OUT_OF_SHAPE}`,
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

// Every reproduction of MC-01's review findings, each named after its finding, with the outcome its
// ruling gives: the rules above as built (a finding, a name read, or, where the rules keep a shape
// out of MC-01, no finding). The scan reads tokens, so none of these depends on how text looks.
const E = "packages/edge/src";

/** MC-01's findings over the planted files, in a scratch copy, as `file message`. */
function mc01(files: Record<string, readonly string[]>): string[] {
  const root = scratch();
  for (const [file, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), lines.join("\n"));
  }
  return checkMonitoring(root, { scan: [] })
    .filter((f) => f.rule === "MC-01")
    .map((f) => `${f.file} ${f.message}`);
}
const seen = (at: string, call: string) => `${at} ${call} is not catalogued`;
const unread = (at: string, call: string) => `${at} ${call} ${CANNOT}`;
const misnamed = (at: string, call: string) => `${at} ${call} ${OUT_OF_SHAPE}`;

describe("MC-01 on each review finding's reproduction", () => {
  it("widened MC-01 skips any writer call whose name is not a literal (switch.set and switch.cleared): each shape is read or a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "export async function setSwitch(deps, input) {",
          '  const event = input.state === "on" ? "edge.switch_set" : "edge.switch_cleared";',
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function guard(context: Context, table: string): void {",
          '  const line: Line = { event: "edge.audit_guard", level: "error", fields: { table } };',
          "  context.log.write(line);",
          "}",
          'const NAMED = "edge.named";',
          'lines.write(NAMED, "warn", {});',
          'const wrap = { write: (event: string) => lines.write(event, "warn", {}) };',
          'wrap.write("edge.wrapped");',
          'o.log?.("edge.optional");',
          "log.write({ ...base, level });",
          'log.write({ ["event"]: "edge.computed", level: "warn" });',
          'function made() { return { event: "edge.returned", level: "warn" }; }',
          "log.write(made());",
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:3`, 'lines.write(event: "edge.switch_set")'),
      seen(`${E}/a.ts:3`, 'lines.write(event: "edge.switch_cleared")'),
      seen(`${E}/a.ts:7`, 'log.write(line: "edge.audit_guard")'),
      seen(`${E}/a.ts:10`, 'lines.write(NAMED: "edge.named")'),
      seen(`${E}/a.ts:12`, 'wrap.write("edge.wrapped")'),
      seen(`${E}/a.ts:13`, 'o.log("edge.optional")'),
      unread(`${E}/a.ts:14`, "log.write({ ...base, level })"),
      unread(`${E}/a.ts:15`, 'log.write({ ["event"]: "edge.computed", level: "warn" })'),
      unread(`${E}/a.ts:17`, "log.write(made())"),
    ]);
  });

  it("a regular expression with a quote or a bracket inside a writer's object or a JSON.stringify drops no event", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'log.write({ event: "edge.regex_failed", level: "error", fields: { code: String(error).replace(/"/g, \'\') } });',
          'log.write({ fields: { name: name.replace(/[(]/g, \'\') }, level: "error", event: "edge.bracket_failed" });',
          'process.stdout.write(JSON.stringify({ detail: text.replace(/\'/g, ""), event: "edge.raw_failed" }));',
          'lines.write("edge.control", "warn", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:1`, 'log.write({ event: "edge.regex_failed" })'),
      seen(`${E}/a.ts:2`, 'log.write({ event: "edge.bracket_failed" })'),
      seen(`${E}/a.ts:4`, 'lines.write("edge.control")'),
      seen(`${E}/a.ts:3`, 'JSON.stringify({ event: "edge.raw_failed" })'),
    ]);
  });

  it("a one-word event through a receiver outside the telemetry writers is dropped by the receiver rule, a dotted one counted (not a finding: the rule kept)", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'deps.sink.write("plantedpanic", "error", {});',
          'options.logger.log("plantedhalt", {}, "error");',
          'deps.sink.write("edge.dotted_seen", "error", {});',
          "const { logUnit } = telemetry;",
          'logUnit("ready");',
        ],
      }),
    ).toEqual([seen(`${E}/a.ts:3`, 'sink.write("edge.dotted_seen")')]);
  });

  it("MC-01 says no writer name is skipped silently, but some still are: an import, a part literal, a reassigned let, another member, a this member are each a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'import { FAILED } from "./names.ts";',
          'import * as names from "./names.ts";',
          'deps.lines.write(FAILED, "warn", {});',
          'lines.write(names.failed, "warn", {});',
          'const event = ok ? "edge.ok" : `edge.$' + "{kind}`;",
          'lines.write(event, "warn", {});',
          'lines.write(ok ? "edge.inline_ok" : other, "warn", {});',
          "function c(deps: Deps, failed: boolean) {",
          '  let event = "edge.done";',
          '  if (failed) event = "edge.failed";',
          '  lines.write(event, "warn", {});',
          "}",
          'const e = { event: "edge.first", alt: "edge.second" };',
          'lines.write(e.alt, "warn", {});',
          'this.lines.write(this.name, "warn", {});',
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:3`, "lines.write(FAILED)"),
      unread(`${E}/a.ts:4`, "lines.write(names.failed)"),
      unread(`${E}/a.ts:6`, "lines.write(event)"),
      unread(`${E}/a.ts:7`, 'lines.write(ok ? "edge.inline_ok" : other)'),
      unread(`${E}/a.ts:11`, "lines.write(event)"),
      unread(`${E}/a.ts:14`, "lines.write(e.alt)"),
      unread(`${E}/a.ts:15`, "lines.write(this.name)"),
    ]);
  });

  it("MC-01 still skips names silently, though it says it never does: each shape is read or a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function a(failed: boolean) {",
          '  let event = "edge.ok";',
          '  if (failed) event = "edge.failed";',
          '  lines.write(event, "warn", {});',
          "}",
          'for (const [event, level] of [["edge.pair_a", "warn"], ["edge.pair_b", "error"]]) lines.write(event, level, {});',
          'import { SWITCH_SET } from "./events.ts";',
          'lines.write(SWITCH_SET, "warn", {});',
          "function late() {",
          '  lines.write(LATE, "warn", {});',
          "}",
          'const LATE = "edge.late";',
          'lines.write(this.name, "warn", {});',
          "function f(failed: boolean) {",
          '  const event = failed ? "edge.failed" : okEvent;',
          '  lines.write(event, "warn", {});',
          "}",
          'lines.write("edge.sign_in" + (failed ? "_failed" : ""), "warn", {});',
          'lines.write("edge.sign-in", "warn", {});',
          'lines.write("edge.Failed", "warn", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:10`, 'lines.write(LATE: "edge.late")'),
      unread(`${E}/a.ts:4`, "lines.write(event)"),
      unread(`${E}/a.ts:6`, "lines.write(event)"),
      unread(`${E}/a.ts:8`, "lines.write(SWITCH_SET)"),
      unread(`${E}/a.ts:13`, "lines.write(this.name)"),
      unread(`${E}/a.ts:16`, "lines.write(event)"),
      unread(`${E}/a.ts:18`, 'lines.write("edge.sign_in" + (failed ? "_failed" : ""))'),
      misnamed(`${E}/a.ts:19`, 'lines.write("edge.sign-in")'),
      misnamed(`${E}/a.ts:20`, 'lines.write("edge.Failed")'),
    ]);
  });

  it("an object argument with a ternary object is no parameter list: its unread name is a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'log.write({ event: name, level: "warn", fields: ok ? { a } : {} });',
          'log.write({ event: name, level: "warn", fields: { a } });',
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:1`, 'log.write({ event: name, level: "warn", fields: ok ? { a } : {} })'),
      unread(`${E}/a.ts:2`, 'log.write({ event: name, level: "warn", fields: { a } })'),
    ]);
  });

  it("a writer's name the file does not declare is a finding: an imported constant, a class field, a helper's or callback's parameter, a loop binding, a default; a constant below is read", () => {
    expect(
      mc01({
        [`${E}/names.ts`]: ['export const DRIFT = "edge.hidden_imported";'],
        [`${E}/a.ts`]: [
          'import { DRIFT } from "./names.ts";',
          "export function drift(deps: Deps) {",
          '  deps.lines.write(DRIFT, "error", {});',
          "}",
          "class Probe {",
          '  readonly event = "edge.hidden_field";',
          "  run(deps: Deps) {",
          '    deps.lines.write(this.event, "error", {});',
          "  }",
          "}",
        ],
        [`${E}/b.ts`]: [
          "export function below(deps: Deps) {",
          '  deps.lines.write(BELOW, "error", {});',
          "}",
          'const BELOW = "edge.hidden_below";',
          "function note(deps: Deps, event: string, fields: object) {",
          '  deps.lines.write(event, "warn", fields);',
          "}",
          'note(deps, on ? "edge.hidden_set" : "edge.hidden_cleared", {});',
          "function line(deps: Deps, event: string, fields: object) {",
          '  deps.lines.write(event, "warn", fields);',
          "}",
          'line(deps, on ? "edge.hidden_set_line" : "edge.hidden_cleared_line", {});',
        ],
        [`${E}/c.ts`]: [
          "for (const [event, level] of pending()) deps.lines.write(event, level, {});",
          'for (const event in NAMES) lines.write(event, "warn", {});',
          'run().catch((event) => lines.write(event, "error", {}));',
          'function fallback(deps: Deps, event = "edge.hidden_default") {',
          '  deps.lines.write(event, "warn", {});',
          "}",
        ],
        // A receiver that is no name (`getLines()`) is the reviewer's (BD-19): no finding.
        [`${E}/d.ts`]: [
          "function bang(deps: Deps) {",
          '  const event = "edge.hidden_bang";',
          '  deps.lines!.write(event, "warn", {});',
          "}",
          "function got(deps: Deps) {",
          '  const event = "edge.hidden_got";',
          '  getLines().write(event, "warn", {});',
          "}",
          'lines.write("edge.hidden_control", "warn", {});',
          "function k() {",
          '  const event = "edge.hidden_const";',
          '  lines.write(event, "warn", {});',
          "}",
        ],
      }),
    ).toEqual([
      seen(`${E}/b.ts:2`, 'lines.write(BELOW: "edge.hidden_below")'),
      seen(`${E}/d.ts:3`, 'lines.write(event: "edge.hidden_bang")'),
      seen(`${E}/d.ts:9`, 'lines.write("edge.hidden_control")'),
      seen(`${E}/d.ts:12`, 'lines.write(event: "edge.hidden_const")'),
      unread(`${E}/a.ts:3`, "lines.write(DRIFT)"),
      unread(`${E}/a.ts:8`, "lines.write(this.event)"),
      unread(`${E}/b.ts:6`, "lines.write(event)"),
      unread(`${E}/b.ts:10`, "lines.write(event)"),
      unread(`${E}/c.ts:1`, "lines.write(event)"),
      unread(`${E}/c.ts:2`, "lines.write(event)"),
      unread(`${E}/c.ts:3`, "lines.write(event)"),
      unread(`${E}/c.ts:5`, "lines.write(event)"),
    ]);
  });

  it("a variable read as a name only in part, reassigned, or declared in a comment or another function is a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function a(deps: Deps, removed: boolean) {",
          '  let event = "csrf.refused";',
          '  if (removed) event = "edge.hidden_reassigned";',
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function b(deps: Deps) {",
          '  const event = kind === "a" ? "csrf.refused" : nameOf(kind);',
          '  deps.lines.write(event, "warn", {});',
          "}",
          'deps.lines.write(on ? "csrf.refused" : other, "warn", {});',
          'deps.lines.write(name ?? "csrf.refused", "warn", {});',
          "function c(deps: Deps) {",
          '  const event = pick(kind, "csrf.refused");',
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function d(context: Context) {",
          '  const line: Line = { event: "csrf.refused", level: "warn", fields: {} };',
          '  line.event = "edge.hidden_mutated";',
          "  context.log.write(line);",
          "}",
          'context.log.write({ event: "csrf.refused", level: "error", fields: {}, ...override });',
          "function e(deps: Deps) {",
          "  const event = nameOf(kind);",
          '  // was: const event = "csrf.refused";',
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function one() {",
          '  const event = "request";',
          "}",
          "function two(deps: Deps, event: string) {",
          '  deps.lines.write(event, "warn", {});',
          "}",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:4`, "lines.write(event)"),
      unread(`${E}/a.ts:8`, "lines.write(event)"),
      unread(`${E}/a.ts:10`, 'lines.write(on ? "csrf.refused" : other)'),
      unread(`${E}/a.ts:11`, 'lines.write(name ?? "csrf.refused")'),
      unread(`${E}/a.ts:14`, "lines.write(event)"),
      unread(`${E}/a.ts:19`, "log.write(line)"),
      unread(
        `${E}/a.ts:21`,
        'log.write({ event: "csrf.refused", level: "error", fields: {}, ...o…)',
      ),
      unread(`${E}/a.ts:25`, "lines.write(event)"),
      unread(`${E}/a.ts:31`, "lines.write(event)"),
    ]);
  });

  it("the parameter-list exclusion swallows no call whose object holds a `? {} : {…}`", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function a(context: Context) {",
          '  context.log.write({ event, level: "error", fields: {} });',
          "}",
          "function b(context: Context, code?: string) {",
          '  context.log.write({ event, level: "error", fields: code === undefined ? {} : { code } });',
          "}",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:2`, 'log.write({ event, level: "error", fields: {} })'),
      unread(
        `${E}/a.ts:5`,
        'log.write({ event, level: "error", fields: code === undefined ? {} …)',
      ),
    ]);
  });

  it("each call reads the nearest declaration of its name, not the first", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function first(deps: Deps) {",
          '  const event = "edge.first_scope";',
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function second(deps: Deps) {",
          '  const event = "edge.second_scope";',
          '  deps.lines.write(event, "warn", {});',
          "}",
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:3`, 'lines.write(event: "edge.first_scope")'),
      seen(`${E}/a.ts:7`, 'lines.write(event: "edge.second_scope")'),
    ]);
  });

  it("a regular expression after `=>`, and a division after a postfix `++` or `!`, hide no writer call", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "const hasTick = (s: string) => /`/.test(s);",
          "function f(deps: Deps) {",
          '  deps.lines.write("edge.after_arrow_tick", "warn", {});',
          "}",
          'const EV = "edge.after_arrow_tick_const";',
          'lines.write(EV, "warn", {});',
        ],
        [`${E}/b.ts`]: [
          'const q = (s) => /"/.test(s); lines.write("edge.same_line", "warn", {}); const t = "x";',
        ],
        [`${E}/c.ts`]: ['i++ / 2; lines.write("edge.after_postfix", "warn", {}); c / 3;'],
        [`${E}/d.ts`]: ['const r = x! / 2; lines.write("edge.after_nonnull", "warn", {}); c / 3;'],
      }),
    ).toEqual([
      seen(`${E}/a.ts:3`, 'lines.write("edge.after_arrow_tick")'),
      seen(`${E}/a.ts:6`, 'lines.write(EV: "edge.after_arrow_tick_const")'),
      seen(`${E}/b.ts:1`, 'lines.write("edge.same_line")'),
      seen(`${E}/c.ts:1`, 'lines.write("edge.after_postfix")'),
      seen(`${E}/d.ts:1`, 'lines.write("edge.after_nonnull")'),
    ]);
  });

  it("a default name on an adapter's first parameter makes it no forward: the write it reaches is a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'function log(event = "edge.default_adapter") {',
          '  lines.write(event, "warn", {});',
          "}",
          "log();",
        ],
      }),
    ).toEqual([unread(`${E}/a.ts:2`, "lines.write(event)")]);
  });

  it("a telemetry writer call in a ternary whose other branch is an arrow function is read", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function f(deps: Deps, ready: boolean) {",
          '  const name = "edge.ternary_arrow";',
          '  const h = ready ? deps.lines.write(name, "warn", {}) : () => undefined;',
          "}",
          "function g(deps: Deps, ready: boolean, name: string) {",
          '  const h = ready ? deps.lines.write(name, "warn", {}) : () => undefined;',
          "}",
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:3`, 'lines.write(name: "edge.ternary_arrow")'),
      unread(`${E}/a.ts:6`, "lines.write(name)"),
    ]);
  });

  it("a let assigned again by a destructuring assignment or in a loop head is a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function a(deps: Deps, other: { event: string }) {",
          '  let event = "edge.default_a";',
          "  ({ event } = other);",
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function b(deps: Deps, other: string[]) {",
          '  let event = "edge.default_b";',
          "  [event] = other;",
          '  deps.lines.write(event, "warn", {});',
          "}",
          "function c(deps: Deps, other: string[]) {",
          '  let event = "edge.default_c";',
          "  for (event of other) {}",
          '  deps.lines.write(event, "warn", {});',
          "}",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:4`, "lines.write(event)"),
      unread(`${E}/a.ts:9`, "lines.write(event)"),
      unread(`${E}/a.ts:14`, "lines.write(event)"),
    ]);
  });

  it("callers of a write or line adapter that call it bare are read where they call it", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "function write(event: string, f: object) {",
          '  deps.lines.write(event, "warn", f);',
          "}",
          "write(pick(kind), {});",
        ],
        [`${E}/b.ts`]: [
          "const line = (event: string) => run.line(event);",
          "line(`deploy.$" + "{kind}`);",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:4`, "write(pick(kind))"),
      unread(`${E}/b.ts:2`, `line(\`deploy.$\{kind}\`)`),
    ]);
  });

  it("honest code the old lexer misread (a regular expression after an arrow or a head, a backtick in JSX text) hides no writer call", () => {
    expect(
      mc01({
        "tools/fin-review/src/zz-probe-a.ts": [
          "export function fences(text: string): string[] {",
          '  return text.split("\\n").filter((line) => /^```/.test(line));',
          "}",
          "export function after(deps: Deps, model: string): void {",
          '  deps.lines.write("review.uncatalogued_failure", "error", { model });',
          "}",
        ],
        [`${E}/b.ts`]: [
          "const bare = (path: string) => /^\\/*$/.test(path);",
          'lines.write("edge.after_bare", "warn", {});',
          "/* closes here */",
        ],
        [`${E}/c.ts`]: [
          "if (ready) /`/.test(text);",
          'lines.write("edge.after_if", "warn", {});',
          "const t = `x`;",
        ],
        [`${E}/d.tsx`]: [
          "export const Help = () => <p>Press ` to open</p>;",
          'lines.write("edge.after_jsx_tick", "warn", {});',
          "export const More = () => <p>Press ` again</p>;",
        ],
      }),
    ).toEqual([
      seen(`${E}/b.ts:2`, 'lines.write("edge.after_bare")'),
      seen(`${E}/c.ts:2`, 'lines.write("edge.after_if")'),
      seen(`${E}/d.tsx:2`, 'lines.write("edge.after_jsx_tick")'),
      seen("tools/fin-review/src/zz-probe-a.ts:5", 'lines.write("review.uncatalogued_failure")'),
    ]);
  });

  it("a telemetry writer's name out of the event-name shape, or a sentence, through a member call is a finding, a variable's too", () => {
    const at = (line: number) => `packages/web-host/src/zz-probe-b.ts:${line}`;
    expect(
      mc01({
        "packages/web-host/src/zz-probe-b.ts": [
          'deps.lines.write("step-up-locked", "error", { realm });',
          'run.line("deployFailed", "error", { step });',
          'telemetry.log("Access keys unavailable", {}, "error");',
          "function a() {",
          '  const event = "auditGuard";',
          '  telemetry.log(event, {}, "error");',
          "}",
          "function b() {",
          '  const message = "sign in failed";',
          '  deps.lines.write(message, "error", {});',
          "}",
          "lines.write(`auth.$" + '{pick({ a: 1 }, kind)}`, "warn", {});',
        ],
      }),
    ).toEqual([
      misnamed(at(1), 'lines.write("step-up-locked")'),
      misnamed(at(2), 'run.line("deployFailed")'),
      misnamed(at(3), 'telemetry.log("Access keys unavailable")'),
      misnamed(at(6), "telemetry.log(event)"),
      misnamed(at(10), "lines.write(message)"),
      unread(at(12), `lines.write(\`auth.$\{pick({ a: 1 }, kind)}\`)`),
    ]);
  });

  it("a wrapper named as a writer method, called bare or through another receiver, is read where it is called", () => {
    const both = 'line(failed ? "deploy.uncatalogued_failed" : "deploy.uncatalog…';
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'const line = (event: string, fields: object) => run.line(event, "error", fields);',
          'line(failed ? "deploy.uncatalogued_failed" : "deploy.uncatalogued_done", { step });',
        ],
        [`${E}/b.ts`]: [
          'const write = (event: string, fields: Fields) => telemetry.log(event, fields, "error");',
          "write(`auth.$" + "{kind}_refused`, {});",
        ],
        [`${E}/c.ts`]: [
          "const { logUnit } = telemetry;",
          'logUnit(failed ? "edge.unit_failed" : "edge.unit_ok", {}, "error");',
        ],
        [`${E}/d.ts`]: [
          'const sink = { write: (event: string) => lines.write(event, "error", {}) };',
          "sink.write(pickName());",
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:2`, `${both}: "deploy.uncatalogued_failed")`),
      seen(`${E}/a.ts:2`, `${both}: "deploy.uncatalogued_done")`),
      seen(
        `${E}/c.ts:2`,
        'logUnit(failed ? "edge.unit_failed" : "edge.unit_ok": "edge.unit_failed")',
      ),
      seen(`${E}/c.ts:2`, 'logUnit(failed ? "edge.unit_failed" : "edge.unit_ok": "edge.unit_ok")'),
      unread(`${E}/b.ts:2`, `write(\`auth.$\{kind}_refused\`)`),
      unread(`${E}/d.ts:2`, "sink.write(pickName())"),
    ]);
  });

  it("in a function named as a writer method, a member of the first parameter other than `.event` is a finding", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "export function format(error: FinError, telemetry: Telemetry): string {",
          '  telemetry.log(error.code, { status: error.status }, "error");',
          "  return error.message;",
          "}",
          "class Rows {",
          "  async write(row: Row) {",
          '    this.o.log.log(row.kind, { id: row.id }, "error");',
          "  }",
          "}",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:2`, "telemetry.log(error.code)"),
      unread(`${E}/a.ts:7`, "log.log(row.kind)"),
    ]);
  });

  it("an inner binding (a second declarator, a renamed pattern, a destructuring assignment, a method named `with`) lets no outer constant stand in", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'const event = "request";',
          "export function a(deps: Deps, kind: string) {",
          '  const level = "error", event = `auth.$' + "{kind}_refused`;",
          "  deps.lines.write(event, level, {});",
          "}",
          "export function b(deps: Deps, { name: event }: { name: string }) {",
          '  deps.lines.write(event, "error", {});',
          "}",
          "export function c(deps: Deps, event: string) {",
          '  deps.lines.write(event, "error", {});',
          "}",
          "export function d(deps: Deps) {",
          "  let event;",
          "  [event] = names();",
          '  deps.lines.write(event, "error", {});',
          "}",
          "class Query {",
          "  with(event: string) {",
          '    deps.lines.write(event, "warn", {});',
          "  }",
          "}",
        ],
      }),
    ).toEqual([
      unread(`${E}/a.ts:4`, "lines.write(event)"),
      unread(`${E}/a.ts:7`, "lines.write(event)"),
      unread(`${E}/a.ts:10`, "lines.write(event)"),
      unread(`${E}/a.ts:15`, "lines.write(event)"),
      unread(`${E}/a.ts:19`, "lines.write(event)"),
    ]);
  });

  it("a raw line whose event is a ternary of two names, or an object held in a constant, is not read (not a finding: the rule kept, a review finding)", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "process.stdout.write(`$" +
            '{JSON.stringify({ event: failed ? "deploy.static_failed" : "deploy.static_ok", level: "error" })}\\n`);',
          'const line = { event: "config.invalid_three", level: "error" };',
          "process.stdout.write(`$" + "{JSON.stringify(line)}\\n`);",
        ],
      }),
    ).toEqual([]);
  });

  it("a sentence through a bare or `this` call of an adapter the file declares is a message (not a finding: the rule kept)", () => {
    expect(
      mc01({
        [`${E}/bare-adapter.ts`]: [
          'const line = (event: string, fields: object) => run.line(event, "error", fields);',
          'line("deploy failed badly", { step });',
          'sink.write("Something failed badly");',
        ],
        [`${E}/this-adapter.ts`]: [
          "class Out {",
          "  write(event: string, fields: object) {",
          '    this.lines.write(event, "error", fields);',
          "  }",
          "  fail() {",
          '    this.write("access keys unavailable", {});',
          "  }",
          "}",
        ],
        [`${E}/control.ts`]: ['lines.write("edge.control_29", "warn", {});'],
      }),
    ).toEqual([seen(`${E}/control.ts:1`, 'lines.write("edge.control_29")')]);
  });

  it("a matched pair of quotes or backticks in JSX text hides no writer call", () => {
    expect(
      mc01({
        [`${E}/jsx-apos.tsx`]: [
          'export const A = () => <p>Don\'t {log.write({ event: "edge.jsx_hidden", level: "warn" })} won\'t</p>;',
        ],
        [`${E}/jsx-tick2.tsx`]: [
          "export const B = () => <p>Press ` to open</p>;",
          "export function f(deps: Deps) {",
          '  deps.lines.write("edge.jsx_tick_hidden", "warn", {});',
          "}",
          "export const C = () => <p>Press ` again</p>;",
        ],
      }),
    ).toEqual([
      seen(`${E}/jsx-apos.tsx:1`, 'log.write({ event: "edge.jsx_hidden" })'),
      seen(`${E}/jsx-tick2.tsx:3`, 'lines.write("edge.jsx_tick_hidden")'),
    ]);
  });

  it("a regular expression that starts a statement after a block hides no writer call", () => {
    expect(
      mc01({
        [`${E}/s7.ts`]: [
          "export function fence(deps: Deps, line: string): boolean {",
          '  if (line === "") {',
          "    return false;",
          "  }",
          '  /^```/.test(line) || deps.lines.write("edge.no_fence", "warn", {});',
          '  deps.lines.write("edge.after_block_regex", "warn", {});',
          "  return true; // a fence is three ` marks",
          "}",
        ],
      }),
    ).toEqual([
      seen(`${E}/s7.ts:5`, 'lines.write("edge.no_fence")'),
      seen(`${E}/s7.ts:6`, 'lines.write("edge.after_block_regex")'),
    ]);
  });

  it("a property named like a keyword divides, and `export default` takes a regular expression: no false refusal, no silent skip", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "const ratio = counts.new / total;",
          'lines.write("edge.after_keyword_division", "warn", {});',
        ],
        [`${E}/b.ts`]: [
          'const half = counts.new / 2; lines.write("edge.hidden_keyword_prop", "warn", {}); const third = half / 3;',
        ],
        [`${E}/c.ts`]: [
          "export default /`/;",
          'lines.write("edge.after_default_regex", "warn", {});',
          "// a ` mark",
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:2`, 'lines.write("edge.after_keyword_division")'),
      seen(`${E}/b.ts:1`, 'lines.write("edge.hidden_keyword_prop")'),
      seen(`${E}/c.ts:2`, 'lines.write("edge.after_default_regex")'),
    ]);
  });

  it("a division after a member named as a keyword (`stats.in / total`) or after `of` hides no writer call, and a single one refuses no file", () => {
    const at = (line: number) => `packages/server/src/zz-probe-r3.ts:${line}`;
    expect(
      mc01({
        "packages/server/src/zz-probe-r3.ts": [
          "export function skew(stats: Stats) {",
          '  return stats.in / stats.out > 2 ? lines.write("edge.r3_skew_failed", "error", {}) : undefined; // too much inbound',
          "}",
          "io.in / io.out > LIMIT && run.line(`deploy.$" +
            '{kind}_failed`, "error", {}); // more in than out',
          'counts.new / counts.total > 0.5 ? note(telemetry.log("signup.surge", {}, "error")) : counts.old / counts.total;',
          'of / total > 1 ? fail(lines.write("edge.over", "error", {})) : of / total;',
        ],
        "packages/server/src/zz-probe-r3b.ts": [
          "const ratio = stats.in / stats.out;",
          'lines.write("request", "info", { ratio });',
        ],
      }),
    ).toEqual([
      seen(at(2), 'lines.write("edge.r3_skew_failed")'),
      seen(at(5), 'telemetry.log("signup.surge")'),
      seen(at(6), 'lines.write("edge.over")'),
      unread(at(4), `run.line(\`deploy.$\{kind}_failed\`)`),
    ]);
  });

  it("a comment that ends in for, if, while or with before `(` neither hides a writer call nor refuses the file", () => {
    expect(
      mc01({
        "packages/server/src/zz-probe-r3.ts": [
          "export function over(used: number, held: number, total: number) {",
          "  return (",
          "    // what the customer pays for",
          '    (used + held) / total > 1 ? fail(lines.write("edge.r3_over_failed", "error", {})) : used / total',
          "  );",
          "}",
        ],
        "packages/server/src/zz-probe-r3b.ts": [
          "export function share(used: number, held: number, total: number) {",
          "  const share =",
          "    // what the customer pays for",
          "    (used + held) / total;",
          '  lines.write("edge.r3_share", "info", { share });',
          "}",
        ],
      }),
    ).toEqual([
      seen("packages/server/src/zz-probe-r3.ts:4", 'lines.write("edge.r3_over_failed")'),
      seen("packages/server/src/zz-probe-r3b.ts:5", 'lines.write("edge.r3_share")'),
    ]);
  });

  it("a literal with a type assertion, or an object's ternary, through a writer that is no telemetry writer is not read (not a finding: the rule kept)", () => {
    expect(
      mc01({
        "packages/server/src/zz-probe-r3.ts": [
          'import { logUnit } from "./telemetry/unit.ts";',
          'logUnit("edge.r3_cast_failed" as EventName, {}, "error");',
          'sink.write("edge.const_failed" as const, "error", {});',
          'out.write("edge.sat_failed" satisfies EventName, "error", {});',
          'sink.write({ event: failed ? "edge.job_failed" : "edge.job_done", level: "error", fields: {} });',
        ],
      }),
    ).toEqual([]);
  });

  it("a dotted lower-case name of five segments or over 64 characters is read as written (not a finding: the event-name shape the rules keep)", () => {
    const long =
      "edge.this_name_is_far_longer_than_the_sixty_four_characters_a_bounded_code_allows";
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'lines.write("edge.staff.enrolment.second_factor.reset_refused", "error", {});',
          `telemetry.log("${long}", {}, "error");`,
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:1`, 'lines.write("edge.staff.enrolment.second_factor.reset_refused")'),
      seen(`${E}/a.ts:2`, `telemetry.log("${long}")`),
    ]);
  });

  it("a sentence through a bare adapter call is a message (not a finding: the rule kept), and an adapter that changes its parameter forwards no name", () => {
    const sentence = 'line("deploy failed at the digest step")';
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'const line = (event: string, fields: object) => run.line(event, "error", fields);',
          'line("deploy failed at the digest step", { step });',
          'out.line("deploy failed at the digest step", { step });',
          'run.line("deploy failed at the digest step", "error", { step });',
        ],
        [`${E}/b.ts`]: [
          "export function log(event: string, fields: Fields) {",
          "  event = `edge.$" + "{event}`;",
          '  telemetry.log(event, fields, "error");',
          "}",
          'log("auth.failed", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/b.ts:5`, 'log("auth.failed")'),
      misnamed(`${E}/a.ts:3`, `out.${sentence}`),
      misnamed(`${E}/a.ts:4`, `run.${sentence}`),
      unread(`${E}/b.ts:3`, "telemetry.log(event)"),
    ]);
  });

  it("a sentence comment's final full stop above `return /re/` hides no writer call, and refuses no file", () => {
    expect(
      mc01({
        [`${E}/probe.ts`]: [
          "export function isFence(line: string): boolean {",
          "  // Three backticks open a fence.",
          "  return /^```/.test(line);",
          "}",
          "export function review(deps: Deps, text: string): void {",
          '  if (!text.split("\\n").some(isFence)) {',
          '    deps.lines.write("review.uncatalogued_failure", "error", {});',
          "  }",
          "  return; // a fence is three ` marks",
          "}",
        ],
        [`${E}/quote.ts`]: [
          "export function quoted(value: string): boolean {",
          "  // A value in quotes is a literal.",
          "  return /^['\"]/.test(value);",
          "}",
          'lines.write("edge.after_quote", "warn", {});',
        ],
        [`${E}/fence-only.ts`]: [
          "export function isFence(line: string): boolean {",
          "  // Three backticks open a fence.",
          "  return /^```/.test(line);",
          "}",
          'lines.write("edge.after_fence_only", "warn", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/fence-only.ts:5`, 'lines.write("edge.after_fence_only")'),
      seen(`${E}/probe.ts:7`, 'lines.write("review.uncatalogued_failure")'),
      seen(`${E}/quote.ts:5`, 'lines.write("edge.after_quote")'),
    ]);
  });

  it("JSX text `{a} / {b}` alone on its line refuses no .tsx file", () => {
    expect(
      mc01({
        [`${E}/c3.tsx`]: [
          "export const Progress = ({ done, total }: Props) => (",
          "  <p>",
          "    {done} / {total}",
          "  </p>",
          ");",
          "export function after(deps: Deps): void {",
          '  deps.lines.write("edge.after_jsx_text", "warn", {});',
          "}",
        ],
      }),
    ).toEqual([seen(`${E}/c3.tsx:7`, 'lines.write("edge.after_jsx_text")')]);
  });

  it("a sentence comment above `return /re/` or `await /re/` makes no keyword a member, and hides no writer call", () => {
    expect(
      mc01({
        [`${E}/md.ts`]: [
          "export function opens(line: string): boolean {",
          "  // A fence opens a code block.",
          "  return /^```/.test(line);",
          "}",
          "export function between(deps: Deps, reason: string): void {",
          '  deps.lines.write("edge.hidden_between_fences", "error", { reason });',
          "}",
          "export function closes(line: string): boolean {",
          "  // A fence closes it.",
          "  return /^```\\s*$/.test(line);",
          "}",
        ],
        [`${E}/wait.ts`]: [
          "export async function a(s: string): Promise<void> {",
          "  // Wait for it.",
          "  await /`/.test(s);",
          '  lines.write("edge.between_awaits", "warn", {});',
          "  // Wait for it.",
          "  await /`/.test(s);",
          "}",
        ],
      }),
    ).toEqual([
      seen(`${E}/md.ts:6`, 'lines.write("edge.hidden_between_fences")'),
      seen(`${E}/wait.ts:4`, 'lines.write("edge.between_awaits")'),
    ]);
  });

  it("JSX `{a}/{b}` refuses no .tsx file, and a `/` after a container hides no writer call", () => {
    expect(
      mc01({
        [`${E}/pages.tsx`]: [
          "export const Pages = ({ page, pages }: Props) => (",
          "  <span>",
          "    {page}/{pages}",
          "  </span>",
          ");",
          'lines.write("edge.after_pages", "warn", {});',
        ],
        [`${E}/inline.tsx`]: [
          'export const P = ({ a }: Props) => <p>{a} / {void lines.write("edge.x", "error", {})} /</p>;',
        ],
      }),
    ).toEqual([
      seen(`${E}/inline.tsx:1`, 'lines.write("edge.x")'),
      seen(`${E}/pages.tsx:6`, 'lines.write("edge.after_pages")'),
    ]);
  });

  it("a line comment that ends in a full stop above `return /re/`, `return !/re/` or `case /re/` hides no writer call and refuses no file", () => {
    expect(
      mc01({
        [`${E}/p1.ts`]: [
          "export function opens(line: string): boolean {",
          "  // Whether the line opens a fence.",
          "  return /^`/.test(line);",
          "}",
          "export function hidden(deps: Deps): void {",
          '  deps.lines.write("edge.hidden_failure", "error", {});',
          "}",
          "export function closes(line: string): boolean {",
          "  // Whether the line closes a fence.",
          "  return /`$/.test(line);",
          "}",
        ],
        [`${E}/p2.ts`]: [
          "export function slashes(path: string): boolean {",
          "  // Whether the path is only slashes.",
          "  return /^\\/*$/.test(path);",
          "}",
          "export function hidden(deps: Deps): void {",
          '  deps.lines.write("edge.hidden_by_comment", "error", {});',
          "}",
          "/* done */",
        ],
        [`${E}/p3.ts`]: [
          "export function plain(text: string): boolean {",
          "  // No code marks in it.",
          "  return !/`/.test(text);",
          "}",
          'lines.write("edge.after_p3", "warn", {});',
        ],
        [`${E}/p4.ts`]: [
          "export function quoted(text: string): boolean {",
          "  // No quotes in it.",
          '  return /"/.test(text);',
          "}",
          'lines.write("edge.after_p4", "warn", {});',
        ],
        [`${E}/p5.ts`]: [
          "export function kind(deps: Deps, line: string): string {",
          "  switch (true) {",
          "    // A fence line.",
          "    case /^`/.test(line):",
          '      deps.lines.write("edge.after_case", "warn", {});',
          '      return "fence";',
          "    default:",
          '      return "text"; // not a ` line',
          "  }",
          "}",
        ],
        [`${E}/p8.ts`]: [
          "export function scheme(deps: Deps, url: string): boolean {",
          "  // Only web addresses pass.",
          '  return /^https?:\\/\\//.test(url) || refuse(deps.lines.write("edge.bad_scheme", "error", {}));',
          "}",
        ],
        [`${E}/p9.ts`]: [
          "export function share(used: number, pending: number, total: number): number {",
          "  const part =",
          "    // the part to compare the total with",
          "    (used + pending) / total;",
          '  lines.write("edge.after_p9", "info", { part });',
          "  return part;",
          "}",
        ],
        [`${E}/p10.ts`]: [
          "export function bare(name: string): boolean {",
          "  // No slash in it.",
          "  return /^[^/]+$/.test(name);",
          "}",
          'lines.write("edge.after_p10", "warn", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/p1.ts:6`, 'lines.write("edge.hidden_failure")'),
      seen(`${E}/p10.ts:5`, 'lines.write("edge.after_p10")'),
      seen(`${E}/p2.ts:6`, 'lines.write("edge.hidden_by_comment")'),
      seen(`${E}/p3.ts:5`, 'lines.write("edge.after_p3")'),
      seen(`${E}/p4.ts:5`, 'lines.write("edge.after_p4")'),
      seen(`${E}/p5.ts:5`, 'lines.write("edge.after_case")'),
      seen(`${E}/p8.ts:3`, 'lines.write("edge.bad_scheme")'),
      seen(`${E}/p9.ts:5`, 'lines.write("edge.after_p9")'),
    ]);
  });

  it("JSX text `{done} / {total}` neither hides the rest of its line nor refuses the file", () => {
    expect(
      mc01({
        [`${E}/p6.tsx`]: [
          'export const Row = ({ done, total }: Props) => <li>{done} / {total} <button onClick={() => lines.write("edge.hidden_in_jsx", "error", {})}>x</button></li>;',
        ],
        [`${E}/p7.tsx`]: [
          "export const Count = ({ done, total }: Props) => (",
          "  <span>",
          "    {done} / {total}",
          "  </span>",
          ");",
          'lines.write("edge.after_p7", "warn", {});',
        ],
      }),
    ).toEqual([
      seen(`${E}/p6.tsx:1`, 'lines.write("edge.hidden_in_jsx")'),
      seen(`${E}/p7.tsx:6`, 'lines.write("edge.after_p7")'),
    ]);
  });

  it("a `for await` head, with or without a comment, and a member named `if` before `(` are read as TypeScript reads them", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "export async function a(rows: AsyncIterable<string>): Promise<void> {",
          '  for await (const row of rows) /`/.test(row) && skip(); deps.lines.write("edge.after_for_await", "warn", {}); const t = `x`;',
          "}",
        ],
        [`${E}/b.ts`]: [
          "export async function b(rows: AsyncIterable<string>): Promise<void> {",
          '  for /* every row */ await (const row of rows) /`/.test(row) && skip(); deps.lines.write("edge.after_for_comment_await", "warn", {}); const t = `x`;',
          "}",
        ],
        [`${E}/c.ts`]: [
          'const r = rule.if(n) / 2; lines.write("edge.after_member_if", "warn", {}); const q = r / 3; const t = `x`;',
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:2`, 'lines.write("edge.after_for_await")'),
      seen(`${E}/b.ts:2`, 'lines.write("edge.after_for_comment_await")'),
      seen(`${E}/c.ts:1`, 'lines.write("edge.after_member_if")'),
    ]);
  });

  it("a block comment before a postfix `++` or `!` hides no writer call", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          'i /* next */ ++ / 2; deps.lines.write("edge.after_postfix_comment", "error", {}); n / 3;',
          'const h = i /* set above */! / 2; deps.lines.write("edge.after_nonnull_comment", "error", {}); n / 3;',
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:1`, 'lines.write("edge.after_postfix_comment")'),
      seen(`${E}/a.ts:2`, 'lines.write("edge.after_nonnull_comment")'),
    ]);
  });

  it("a numeric literal ending in a dot, then a comment, makes no keyword a member: no writer call hidden", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "export function f(deps: Deps, s: string) {",
          "  const x = 1. // one",
          '  return /`/.test(s) ? deps.lines.write("edge.hidden_numeric", "error", {}) : x > 0; // no ` here',
          "}",
        ],
      }),
    ).toEqual([seen(`${E}/a.ts:3`, 'lines.write("edge.hidden_numeric")')]);
  });

  it("`for /* … */ await (` is a head and `clock.for(id)` a call: no writer call hidden", () => {
    expect(
      mc01({
        [`${E}/a.ts`]: [
          "export async function f(items: AsyncIterable<string>) {",
          '  for /* each */ await (const s of items) /`/.test(s) && deps.lines.write("edge.for_await", "error", {}); // a ` mark',
          "}",
        ],
        [`${E}/b.ts`]: [
          'const t = clock.for(id) / 2; lines.write("edge.after_member_for", "info", {}); const q = t / 3;',
        ],
      }),
    ).toEqual([
      seen(`${E}/a.ts:2`, 'lines.write("edge.for_await")'),
      seen(`${E}/b.ts:1`, 'lines.write("edge.after_member_for")'),
    ]);
  });
});
