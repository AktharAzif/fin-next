// ops/credentials.json ([OP-05], spec 01 §9.6): every row is complete, names a runbook that exists
// (or says which lane brings it), and holds no value. `monitoring:check` validates it again once
// ops/monitoring exists.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { REPO_ROOT } from "./helpers/fixtures.ts";

interface Row {
  name: string;
  ref: string;
  holder: string;
  issuer: string;
  created: string | null;
  expires: string | null;
  cadence: string;
  runbook: string | null;
  pending?: string;
}

const file = join(REPO_ROOT, "ops", "credentials.json");
const text = readFileSync(file, "utf8");
const inventory = JSON.parse(text) as { version: number; environment: string; credentials: Row[] };

describe("the credential inventory", () => {
  it("has a complete row for every credential", () => {
    assert.equal(inventory.version, 1);
    assert.equal(inventory.environment, "staging");
    const names = new Set<string>();
    for (const row of inventory.credentials) {
      for (const key of ["name", "ref", "holder", "issuer", "cadence"] as const) {
        assert.ok(typeof row[key] === "string" && row[key].length > 0, `${row.name}: ${key}`);
      }
      assert.match(row.name, /^[a-z0-9-]+$/);
      assert.equal(names.has(row.name), false, `${row.name} twice`);
      names.add(row.name);
      for (const date of [row.created, row.expires]) {
        assert.ok(
          date === null || /^\d{4}-\d{2}-\d{2}$/.test(date),
          `${row.name}: a date is YYYY-MM-DD`,
        );
      }
      const allowed = new Set([
        "name",
        "ref",
        "holder",
        "issuer",
        "created",
        "expires",
        "cadence",
        "runbook",
        "pending",
      ]);
      for (const key of Object.keys(row))
        assert.ok(allowed.has(key), `${row.name}: unexpected key ${key}`);
    }
  });

  it("names a runbook that exists, or the lane that brings it", () => {
    for (const row of inventory.credentials) {
      if (row.runbook === null) {
        assert.ok((row.pending ?? "").length > 10, `${row.name}: a row without a runbook says why`);
        continue;
      }
      assert.ok(
        existsSync(join(REPO_ROOT, "docs", "runbooks", row.runbook)),
        `${row.name}: docs/runbooks/${row.runbook}`,
      );
    }
  });

  it("covers every credential pnpm fin mints or sets", () => {
    for (const name of [
      "cloudflare-operator-token",
      "railway-project-token",
      "tunnel-token-public",
      "tunnel-token-admin",
      "ingress-proofs",
      "email-token",
    ]) {
      assert.ok(
        inventory.credentials.some((r) => r.name === name),
        name,
      );
    }
  });

  it("holds no value, ID or address", () => {
    assert.doesNotMatch(text, /[0-9a-f]{32}/);
    assert.doesNotMatch(text, /[0-9a-f]{8}-[0-9a-f]{4}-/);
    assert.doesNotMatch(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]/);
    assert.doesNotMatch(text, /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });
});
