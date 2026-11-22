// Every field an alert reads (its value, its filters and its series) is a key that a writer of one
// of its events writes: an alert on a field nobody writes can never fire. A writer is a file of
// the code MC-01 scans that names the event as a quoted string outside a comment; a field is
// written there, outside a comment, as a key or a shorthand property. The fields no such file
// writes in this tree are listed by name below, each with the reason, and a new one fails here
// until it is written, listed, or its alert owed (catalog/owed.ts). Nor does an alert read a field
// whose name the telemetry withholds (spec 08 §5.4): every value under such a name reaches Better
// Stack as "[withheld]", so the alert could never see it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVELOPE_FIELDS } from "../catalog/types.ts";
import { readCode } from "../src/check.ts";
import { loadEnv } from "../src/config.ts";
import { queryEvents, queryFields, seriesFields } from "../src/sql.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const HEALTH_HOOK =
  "process.health carries what a service's health hook returns (packages/server's BuiltService.health), in a file that need not name the event; the worker's hook (apps/api/src/worker/main.ts, on int/batch) returns it";
const NO_WRITER = (writer: string) => `no process writes the event yet: ${writer} will`;

/** `<alert>/<field>`: a field its alert reads that no file naming the alert's events writes here. */
const UNWRITTEN: Readonly<Record<string, string>> = {
  "database-unreachable/dbOk": HEALTH_HOOK,
  "pool-exhausted/poolWaiting": HEALTH_HOOK,
  "privileged-login/registered": NO_WRITER("P0-E's matcher of ops.privileged_login"),
  "privileged-login/role": NO_WRITER("P0-E's matcher of ops.privileged_login"),
  "grants-drift/role": NO_WRITER("the hourly grants drift check"),
};

const { config } = loadEnv(ROOT, "staging");
// Comment lines and trailing comments dropped: a comment that names an event or a field writes
// neither.
const code = readCode(ROOT).map(({ text }) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line))
    .map((line) => line.replace(/\s\/\/\s.*$/, ""))
    .join("\n"),
);

/** Each staging alert's `<alert>/<field>` for every field it reads beyond the envelope. */
function readFields(): { key: string; events: readonly string[]; field: string }[] {
  const out: { key: string; events: readonly string[]; field: string }[] = [];
  for (const alert of config?.alerts ?? []) {
    const fields = new Set([...queryFields(alert.query), ...(seriesFields(alert) ?? [])]);
    for (const field of fields) {
      if (ENVELOPE_FIELDS.includes(field)) continue;
      out.push({ key: `${alert.name}/${field}`, events: queryEvents(alert.query), field });
    }
  }
  return out;
}

function written(events: readonly string[], field: string): boolean {
  const names = events.map((e) => new RegExp(`["']${e.replaceAll(".", "\\.")}["']`));
  const key = new RegExp(`(?<![\\w$.])${field}(?:\\s*\\??\\s*:|\\s*[,}])`);
  return code.some((text) => names.some((name) => name.test(text)) && key.test(text));
}

describe("the staging alerts' fields", () => {
  it("are each written by a writer of the alert's events, or listed with the reason", () => {
    expect(config).toBeDefined();
    const unwritten = readFields()
      .filter(({ events, field }) => !written(events, field))
      .map(({ key }) => key);
    expect(unwritten.filter((key) => UNWRITTEN[key] === undefined)).toEqual([]);
  });

  it("list only fields a staging alert reads", () => {
    const read = new Set(readFields().map(({ key }) => key));
    expect(Object.keys(UNWRITTEN).filter((key) => !read.has(key))).toEqual([]);
  });

  it("leave clock-skew owed while no process writes clockSkewMs", () => {
    expect(written(["process.health"], "clockSkewMs")).toBe(false);
    expect(config?.alerts.some((a) => a.name === "clock-skew")).toBe(false);
  });

  it("are never a name the telemetry withholds", () => {
    const names = withheldNames();
    // The list was read: spec 08 §5.4's names are in it.
    for (const name of ["code", "email", "token", "message"]) {
      expect(names.has(name), name).toBe(true);
    }
    const refused = readFields()
      .filter(({ field }) => names.has(field.toLowerCase().replace(/[_-]/g, "")))
      .map(({ key }) => key);
    expect(refused).toEqual([]);
  });
});

/**
 * The field names @fin/core's scrubber withholds (WITHHELD_FIELDS in packages/core's
 * scrub-shapes.ts), read as text: ops/monitoring imports no other package. A name is compared as
 * the scrubber compares it, lower case with `_` and `-` removed.
 */
function withheldNames(): Set<string> {
  const text = readFileSync(join(ROOT, "packages", "core", "src", "scrub-shapes.ts"), "utf8");
  const list = /WITHHELD_FIELDS\b[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(text)?.[1] ?? "";
  return new Set([...list.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? ""));
}
