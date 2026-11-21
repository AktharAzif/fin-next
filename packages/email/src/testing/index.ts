// Test helpers for this package and the worker's email tests: a fake transport behind EmailPort, a
// line recorder, and the outbox schema loader for integration tests on a real Postgres 18. Never
// imported by release code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { grantSyncSql, SENDER_ROLES, type SenderRole } from "../catalogue.ts";
import type { Queryable } from "../outbox/db.ts";
import type { EmailPort, OutgoingEmail, SendOutcome } from "../port.ts";
import type { EmailLog, Level } from "../sender/sender.ts";

export const OK: SendOutcome = Object.freeze({
  ok: true,
  status: "delivered",
  tries: 1,
  durationMs: 12,
  httpStatus: 200,
});

export function failure(
  kind: "permanent" | "throttled" | "blocked" | "unknown",
  code: string,
  extra: Partial<{ retryAfterMs: number; severity: "page" | "alert" | "none" }> = {},
): SendOutcome {
  return {
    ok: false,
    kind,
    code,
    tries: 1,
    durationMs: 15,
    severity: extra.severity ?? "none",
    ...extra,
  };
}

/** An EmailPort that records every message and answers from a script (OK when the script is empty). */
export class FakeTransport implements EmailPort {
  readonly sent: OutgoingEmail[] = [];
  private readonly script: SendOutcome[] = [];
  private readonly byTemplate = new Map<string, SendOutcome[]>();

  /** Queues answers for the next sends, in order. */
  answer(...outcomes: SendOutcome[]): this {
    this.script.push(...outcomes);
    return this;
  }

  /** Queues answers for one template's sends. */
  answerFor(template: string, ...outcomes: SendOutcome[]): this {
    this.byTemplate.set(template, [...(this.byTemplate.get(template) ?? []), ...outcomes]);
    return this;
  }

  async send(message: OutgoingEmail): Promise<SendOutcome> {
    this.sent.push(message);
    const own = this.byTemplate.get(message.template);
    if (own !== undefined && own.length > 0) return own.shift() as SendOutcome;
    return this.script.shift() ?? OK;
  }

  of(template: string): OutgoingEmail[] {
    return this.sent.filter((m) => m.template === template);
  }
}

export interface RecordedLine {
  readonly event: string;
  readonly level: Level;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Records lines as the telemetry would receive them. */
export class LineRecorder implements EmailLog {
  readonly lines: RecordedLine[] = [];

  log(event: string, fields: Readonly<Record<string, unknown>>, level: Level = "info"): void {
    this.lines.push({ event, level, fields });
  }

  named(event: string): RecordedLine[] {
    return this.lines.filter((l) => l.event === event);
  }

  /** Every line serialised, for "no address ever appears" checks. */
  text(): string {
    return this.lines.map((l) => JSON.stringify({ event: l.event, ...l.fields })).join("\n");
  }
}

const SQL_DIR = join(import.meta.dirname, "..", "..");

/** This package's migration, which `migrate` applies over P0-E's outbox. */
export const SENDER_MIGRATION = "20261121121000_email_sender.sql";

/**
 * The grant fragments the sender's objects take in `migrate` (packages/db/src/grants.ts's shape): P0-E's
 * `email` fragment (the schema, email.enqueue() and the outbox) and this package's own.
 */
export const SENDER_GRANT_FRAGMENTS: readonly string[] = [
  join(SQL_DIR, "..", "db", "roles", "grants", "email.json"),
  join(SQL_DIR, "grants", "email-sender.json"),
];

interface FragmentEntry {
  on: "schema" | "table" | "function";
  name: string;
  privileges: string[];
  columns?: string[];
  to: string[];
}

/** The fragments as GRANT statements, each group written `{{fin_worker}}` for the tests to map. */
export function senderGrantSql(fragments: readonly string[] = SENDER_GRANT_FRAGMENTS): string {
  const lines: string[] = [];
  for (const file of fragments) {
    const { grants } = JSON.parse(readFileSync(file, "utf8")) as { grants: FragmentEntry[] };
    for (const entry of grants) {
      const columns = entry.columns === undefined ? "" : ` (${entry.columns.join(", ")})`;
      const privileges = entry.privileges.map((p) => `${p}${columns}`).join(", ");
      const target = entry.on === "table" ? "TABLE" : entry.on === "schema" ? "SCHEMA" : "FUNCTION";
      const to = entry.to.map((role) => `{{${role}}}`).join(", ");
      lines.push(`GRANT ${privileges} ON ${target} ${entry.name} TO ${to};`);
    }
  }
  return lines.join("\n");
}

/** The fixture schema text: the spec 01 §6.10 stand-in, then this lane's migration and its grants. */
export function outboxSchemaSql(): { base: string; extension: string; grants: string } {
  return {
    base: readFileSync(join(SQL_DIR, "test", "fixture", "outbox-base.sql"), "utf8"),
    extension: readFileSync(join(SQL_DIR, "migrations", SENDER_MIGRATION), "utf8"),
    grants: senderGrantSql(),
  };
}

/**
 * Drops and recreates the `email` (and stand-in `ops`) schema in the connected (lane-owned)
 * database: the base migration with its seeded grant, then the extension and its grants with each
 * group role mapped by `roleName`, then the generated template grants, exactly as `migrate` loads
 * them over the seeded row.
 */
export async function installOutboxSchema(
  db: Queryable,
  roleName: (role: SenderRole) => string,
): Promise<void> {
  const sql = outboxSchemaSql();
  const render = (text: string): string => {
    let out = text;
    for (const role of SENDER_ROLES) out = out.replaceAll(`{{${role}}}`, roleName(role));
    return out;
  };
  await db.query("DROP SCHEMA IF EXISTS email CASCADE");
  await db.query("DROP SCHEMA IF EXISTS ops CASCADE");
  await db.query(render(sql.base));
  await db.query(sql.extension);
  await db.query(render(sql.grants));
  await db.query(grantSyncSql(roleName));
}
