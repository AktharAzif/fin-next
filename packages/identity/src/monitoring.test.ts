// Every line the package writes is catalogued with its kind and its alerts or a reason (R5,
// spec 02 §18, AC-SAT-37's identity half).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IDENTITY_LINES } from "./monitoring.ts";

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".ts") && !entry.name.includes(".test.") ? [path] : [];
  });
}

describe("the identity line catalogue", () => {
  const written = new Set<string>();
  for (const file of sources(import.meta.dirname)) {
    for (const match of readFileSync(file, "utf8").matchAll(/write\(\s*"([a-z_.]+)"/g)) {
      written.add(match[1] as string);
    }
  }

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
});
