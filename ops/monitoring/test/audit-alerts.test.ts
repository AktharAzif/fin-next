// The alerts identity's line list (packages/identity/src/monitoring.ts) names for audit.write_failed
// are staging rules over that event, as spec 08 §3.14 defines them, each with a runbook that exists
// and names it back, and the catalogue's entry names the same alerts. The fields each writer passes
// are the ones the catalogue declares, and the catalogue and runbook say which writer leaves which
// out. The list and the writers are read as text: ops/monitoring imports no other package.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fragments } from "../catalog/index.ts";
import { loadEnv } from "../src/config.ts";
import { queryEvents } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const IDENTITY_LINES = join(ROOT, "packages", "identity", "src", "monitoring.ts");
const EVENT = "audit.write_failed";
const AUDIT_WRITER = join(ROOT, "packages", "audit", "src", "record.ts");
const IDENTITY_WRITER = join(ROOT, "packages", "identity", "src", "audit", "record.ts");
const RUNBOOK = join(ROOT, "docs", "runbooks", "audit-not-written.md");
/** What the catalogue and runbook say while identity passes the audit event as the envelope's key. */
const IDENTITY_GAP = "passes the event's name as `event`";

/**
 * The field names each write of the event in a file passes, one list per write: the first object
 * literal after the quoted name, which is the fields in both `write(name, level, { ... })` and
 * `write({ event: name, level, fields: { ... } })`.
 */
function writtenFields(file: string): string[][] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/"audit\.write_failed"/g)].map((m) => {
    const open = text.indexOf("{", m.index + m[0].length);
    const close = open === -1 ? -1 : text.indexOf("}", open);
    const body = close === -1 ? "..." : text.slice(open + 1, close).trim();
    if (body.includes("...") || body.includes("{")) {
      throw new Error(`${file}: a write of ${EVENT} whose fields cannot be read as text`);
    }
    return fieldNames(body);
  });
}

/** The keys of a flat object literal's body: each name at the start or after a comma. */
function fieldNames(body: string): string[] {
  return [...body.trim().matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=:|,|$)/g)].map(
    (k) => k[1] ?? "",
  );
}

function catalogueEntry() {
  const entry = Object.values(fragments)
    .flat()
    .find((e) => e.event === EVENT);
  if (entry === undefined) throw new Error(`${EVENT} is not in the catalogue`);
  return entry;
}

/** The alert names identity's list gives an event: its `alerts: [...]`, or none for a reason. */
function identityAlerts(event: string): string[] {
  const text = readFileSync(IDENTITY_LINES, "utf8");
  const key = `"${event}":`;
  const start = text.indexOf(key);
  if (start === -1) throw new Error(`${event} is not in identity's line list`);
  const entry = text.slice(start + key.length, text.indexOf("}", start));
  const list = /alerts:\s*\[([^\]]*)\]/.exec(entry);
  return [...(list?.[1] ?? "").matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1] ?? "");
}

describe(`the alerts identity names for ${EVENT}`, () => {
  const names = identityAlerts(EVENT);
  const { config, findings } = loadEnv(ROOT, "staging");

  it("are read from identity's list, audit-not-written among them", () => {
    expect(names).toContain("audit-not-written");
  });

  it("exist as staging rules that watch the event, with a runbook that names them", () => {
    expect(findings).toEqual([]);
    for (const name of names) {
      const rule = config?.alerts.find((a) => a.name === name);
      expect(rule, `${name} is no rule in ops/monitoring/staging/alerts`).toBeDefined();
      if (rule === undefined) continue;
      expect(queryEvents(rule.query), name).toEqual([EVENT]);
      const runbook = rule.metadata?.runbook ?? "";
      expect(runbook, name).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
      expect(existsSync(join(ROOT, runbook)), `${name}: ${runbook} does not exist`).toBe(true);
      expect(readFileSync(join(ROOT, runbook), "utf8"), runbook).toContain(`\`${name}\``);
    }
  });

  it("are the alerts the catalogue's entry names", () => {
    expect(catalogueEntry().alerts).toEqual(names);
  });

  it("page on any refusal, as spec 08 §3.14's audit-not-written does", () => {
    const rule = config?.alerts.find((a) => a.name === "audit-not-written");
    expect(rule).toMatchObject({
      group: "D",
      severity: "P",
      operator: "higher_than",
      threshold: "@any",
      policy: "staging-quiet",
      metadata: { runbook: "docs/runbooks/audit-not-written.md" },
    });
    expect(rule?.query).toEqual({ count: { events: [EVENT] } });
  });
});

describe(`the fields the writers of ${EVENT} pass`, () => {
  const entry = catalogueEntry();
  const declared = Object.keys(entry.fields).sort();

  it("are, from packages/audit's recordAudit, exactly the catalogue's", () => {
    const writes = writtenFields(AUDIT_WRITER);
    expect(writes.length).toBeGreaterThan(0);
    for (const fields of writes) expect([...fields].sort()).toEqual(declared);
  });

  it("are, from identity's recorder, the catalogue's or the envelope's `event`, which the catalogue and runbook name", () => {
    const writes = writtenFields(IDENTITY_WRITER);
    expect(writes.length).toBeGreaterThan(0);
    for (const fields of writes) {
      for (const field of fields) expect(["event", ...declared], field).toContain(field);
    }
    // While identity passes `event`, its lines arrive without the audit event's name, and the
    // catalogue and runbook must say so; once it passes `auditEvent`, they must stop saying it.
    const passesEvent = writes.some((fields) => fields.includes("event"));
    const says = (text: string) => text.replace(/\s+/g, " ").includes(IDENTITY_GAP);
    expect(says(entry.writtenBy), "the catalogue's writtenBy").toBe(passesEvent);
    expect(says(readFileSync(RUNBOOK, "utf8")), "the runbook").toBe(passesEvent);
  });

  it("are read as keys, never as the values' names, shorthand keys included", () => {
    expect(fieldNames('event: input.event,\n sqlstate: sqlState(error) ?? "unknown",')).toEqual([
      "event",
      "sqlstate",
    ]);
    expect(fieldNames("auditEvent: event, sqlstate: state")).toEqual(["auditEvent", "sqlstate"]);
    expect(fieldNames("table, sqlstate")).toEqual(["table", "sqlstate"]);
  });
});
