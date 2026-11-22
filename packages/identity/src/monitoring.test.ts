// Every line the package writes is catalogued with its kind and its alerts or a reason (R5,
// spec 02 §18, AC-SAT-37's identity half), and no line names a field after the envelope.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ENVELOPE_KEYS } from "@fin/server/telemetry";
import { describe, expect, it } from "vitest";
import { IDENTITY_LINES } from "./monitoring.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

/**
 * Each `write("<event>", <level>, <fields>)` call, with the text of its fields from the first `{`
 * to the call's closing parenthesis (empty when the fields are passed by name).
 */
function writeCalls(text: string): { event: string; fields: string }[] {
  const calls: { event: string; fields: string }[] = [];
  for (const match of text.matchAll(/write\(\s*"([a-z_.]+)"/g)) {
    let depth = 0;
    let end = match.index;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    const call = text.slice(match.index, end + 1);
    const open = call.indexOf("{");
    calls.push({ event: match[1] as string, fields: open === -1 ? "" : call.slice(open) });
  }
  return calls;
}

describe("the identity line catalogue", () => {
  const files = sources(import.meta.dirname).map((path) => ({
    file: relative(import.meta.dirname, path),
    text: readFileSync(path, "utf8"),
  }));
  const written = new Set(files.flatMap(({ text }) => writeCalls(text).map((c) => c.event)));

  it("names every line the code writes", () => {
    expect(written.size).toBeGreaterThan(10);
    for (const event of written) expect(Object.keys(IDENTITY_LINES), event).toContain(event);
  });

  it("gives every failure and security line an alert or a written reason", () => {
    for (const [event, spec] of Object.entries(IDENTITY_LINES)) {
      if (Array.isArray(spec.alerts)) expect(spec.alerts.length, event).toBeGreaterThan(0);
      else expect((spec.alerts as { none: string }).none.length, event).toBeGreaterThan(10);
    }
  });

  // The process telemetry drops a field that shares a name with the envelope (`event`, `level`,
  // `requestId`...), so such a field never reaches Better Stack: `audit.write_failed` names its
  // event `auditEvent`, `auth.library_log` its level `libraryLevel`.
  it("names no line field, and no request-line field, after the envelope", () => {
    const keys = [...ENVELOPE_KEYS].join("|");
    const field = new RegExp(`[{,]\\s*(${keys})\\s*[:,}]`);
    const requestLine = new RegExp(
      `\\.line\\.(${keys})\\b|\\bline:\\s*\\{[^}]*\\b(${keys})\\s*[:,}]`,
    );
    const found: string[] = [];
    for (const { file, text } of files) {
      for (const { event, fields } of writeCalls(text)) {
        const hit = field.exec(fields);
        if (hit !== null) found.push(`${file}: ${event} sets ${hit[1]}`);
      }
      const hit = requestLine.exec(text);
      if (hit !== null) found.push(`${file}: the request line sets ${hit[1] ?? hit[2]}`);
    }
    expect(found).toEqual([]);
  });
});
