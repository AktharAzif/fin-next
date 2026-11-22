// The grant matrix's guards (grants.ts). Each one reads every package's fragments the way `migrate`
// reads them (apps/api/src/migrate/main.ts: loadDbAssets at dbAssetsRoot), so a grant in any
// package's fragment is held to them, not only one in packages/db's own.
import {
  existsSync,
  globSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dbAssetsRoot, sourceRoot, stageDbAssets } from "./assets.ts";
import { MigrationError } from "./errors.ts";
import {
  expandMatrix,
  type GrantEntry,
  type GrantFragment,
  loadFragments,
  normaliseSignature,
  type Privilege,
  parseFragment,
  privilegeKey,
} from "./grants.ts";
import { GRANTS_DIR, loadDbAssets } from "./migrations.ts";

const ROOT = sourceRoot() ?? "";
const temporary: string[] = [];

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MigrationError) return error.code;
    throw error;
  }
  return "none";
}

/**
 * Every package's fragments, read by `migrate`'s own loader: from the source tree, or from an assets
 * directory laid out as the image's FIN_DB_ASSETS_DIR.
 */
function migrateFragments(assetsDir?: string): GrantFragment[] {
  return loadDbAssets(dbAssetsRoot(assetsDir === undefined ? {} : { FIN_DB_ASSETS_DIR: assetsDir }))
    .fragments;
}

/** The repository's database files staged as the image holds them, for a test to change. */
function stagedAssets(): string {
  const out = join(mkdtempSync(join(tmpdir(), "fin-db-grants-")), "db-assets");
  temporary.push(dirname(out));
  stageDbAssets(ROOT, out);
  return out;
}

/**
 * What any role but the worker and email.enqueue()'s owner holds on email_private or on anything in
 * it: the schema, its tables (whole or by column) and its functions, whichever fragment grants it.
 */
function emailPrivateOutsiders(matrix: readonly Privilege[]): string[] {
  return matrix
    .filter((p) => p.object === "email_private" || p.object.startsWith("email_private."))
    .filter((p) => p.role !== "fin_worker" && p.role !== "fin_email_enqueue")
    .map((p) => privilegeKey(p));
}

/**
 * email_private stays closed: only the worker and email.enqueue()'s owner hold anything on the
 * schema or on anything in it, and that owner holds only what enqueue needs.
 */
function expectEmailPrivateClosed(matrix: readonly Privilege[]): void {
  expect(emailPrivateOutsiders(matrix)).toEqual([]);
  expect(
    matrix
      .filter((p) => p.kind === "schema" && p.object === "email_private")
      .map((p) => p.role)
      .sort(),
  ).toEqual(["fin_email_enqueue", "fin_worker"]);
  expect(
    matrix
      .filter((p) => p.role === "fin_email_enqueue")
      .map((p) => privilegeKey(p))
      .sort(),
  ).toEqual([
    "schema email USAGE fin_email_enqueue",
    "schema email_private USAGE fin_email_enqueue",
    "table email.template_grant SELECT fin_email_enqueue",
    "table email_private.outbox INSERT fin_email_enqueue",
  ]);
  // Nothing but enqueue's owner inserts into the outbox; nothing but the worker reads or changes it.
  expect(
    matrix
      .filter((p) => p.object === "email_private.outbox")
      .map((p) => `${p.privilege} ${p.role}`)
      .sort(),
  ).toEqual([
    "DELETE fin_worker",
    "INSERT fin_email_enqueue",
    "SELECT fin_worker",
    "UPDATE fin_worker",
  ]);
}

describe("grant fragments", () => {
  it("loads Phase 0's fragments, one per area named after its file", () => {
    expect(loadFragments(GRANTS_DIR).map((f) => f.area)).toEqual([
      "audit",
      "email",
      "events",
      "ops",
    ]);
  });

  it("reads every package's fragments for its guards, as migrate does", () => {
    const fragments = migrateFragments();
    const files = globSync(["packages/*/grants/*.json", "packages/db/roles/grants/*.json"], {
      cwd: ROOT,
    })
      .map((path) => basename(path))
      .sort();
    expect(fragments.map((f) => f.file).sort()).toEqual(files);
    expect(fragments.map((f) => f.area)).toEqual(
      expect.arrayContaining([
        "audit",
        "email",
        "email-sender",
        "events",
        "identity",
        "limits",
        "ops",
        "orgs",
        "staff",
        "staff-realm",
        "step-up",
      ]),
    );
  });

  it("never grants a write on an audit table, or on the kill switches, to any role", () => {
    const matrix = expandMatrix(migrateFragments());
    const writes = matrix.filter(
      (p) =>
        p.kind === "table" &&
        p.privilege !== "SELECT" &&
        (p.object.startsWith("audit.") || p.object.startsWith("ops.kill_switch")),
    );
    expect(writes).toEqual([]);
  });

  it("grants audit.record and email.enqueue to the five recording roles and nothing else", () => {
    const matrix = expandMatrix(migrateFragments());
    const holders = (object: string) =>
      matrix
        .filter((p) => p.object === object)
        .map((p) => p.role)
        .sort();
    const five = ["fin_admin", "fin_api", "fin_console", "fin_payments", "fin_worker"];
    expect(holders("audit.record(jsonb)")).toEqual(five);
    expect(holders("email.enqueue(jsonb)")).toEqual(five);
    expect(holders("audit.sequence(integer)")).toEqual(["fin_worker"]);
    expect(holders("audit.unsequenced_age()")).toEqual(["fin_probe"]);
    expect(holders("ops.set_switch(text, text, text, jsonb)")).toEqual(["fin_admin"]);
  });

  it("opens email_private to the worker and enqueue's owner only, and gives that owner only what enqueue needs", () => {
    expectEmailPrivateClosed(expandMatrix(migrateFragments()));
    // The staged copy migrate reads in an image passes too, so the planted cases below fail for
    // their grant alone.
    expectEmailPrivateClosed(expandMatrix(migrateFragments(stagedAssets())));
  });

  it("fails when any package's fragment grants on email_private to another role", () => {
    const planted: { file: string; entry: GrantEntry; key: string }[] = [
      {
        file: "packages/identity/grants/identity.json",
        entry: {
          on: "table",
          name: "email_private.outbox",
          privileges: ["SELECT"],
          to: ["fin_api"],
        },
        key: "table email_private.outbox SELECT fin_api",
      },
      {
        file: "packages/staff/grants/staff.json",
        entry: { on: "schema", name: "email_private", privileges: ["USAGE"], to: ["fin_admin"] },
        key: "schema email_private USAGE fin_admin",
      },
      {
        file: "packages/email/grants/email-sender.json",
        entry: {
          on: "table",
          name: "email_private.recipient_window",
          privileges: ["SELECT"],
          columns: ["count"],
          to: ["fin_readonly"],
        },
        key: "table email_private.recipient_window(count) SELECT fin_readonly",
      },
      {
        file: "packages/orgs/grants/orgs.json",
        entry: {
          on: "table",
          name: "email_private.daily_budget",
          privileges: ["UPDATE"],
          to: ["fin_payments"],
        },
        key: "table email_private.daily_budget UPDATE fin_payments",
      },
      {
        file: "packages/planted/grants/planted.json",
        entry: {
          on: "function",
          name: "email_private.claim(integer)",
          privileges: ["EXECUTE"],
          to: ["fin_probe"],
        },
        key: "function email_private.claim(integer) EXECUTE fin_probe",
      },
    ];
    for (const { file, entry, key } of planted) {
      const dir = stagedAssets();
      const path = join(dir, ...file.split("/"));
      // An existing fragment gains the entry; a package with none gets its first.
      const fragment: { area: string; grants: unknown[] } = existsSync(path)
        ? JSON.parse(readFileSync(path, "utf8"))
        : { area: basename(path, ".json"), grants: [] };
      mkdirSync(dirname(path), { recursive: true });
      fragment.grants.push(entry);
      writeFileSync(path, JSON.stringify(fragment));
      const matrix = expandMatrix(migrateFragments(dir));
      expect(emailPrivateOutsiders(matrix), file).toEqual([key]);
      expect(() => expectEmailPrivateClosed(matrix), file).toThrow();
    }
  });

  it("expands column grants to one privilege per column", () => {
    const matrix = expandMatrix(migrateFragments());
    expect(
      matrix
        .filter((p) => p.object.startsWith("ops.scheduler_lease(") && p.role === "fin_worker")
        .map((p) => p.object),
    ).toEqual([
      "ops.scheduler_lease(holder)",
      "ops.scheduler_lease(renewed_at)",
      "ops.scheduler_lease(until)",
    ]);
  });

  it("refuses a fragment with an unknown role, privilege, key or object outside Fin's schemas", () => {
    const base = { area: "ops", grants: [] as unknown[] };
    const bad = [
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: ["postgres"] }],
      },
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["TRUNCATE"], to: ["fin_api"] }],
      },
      { ...base, grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: [] }] },
      {
        ...base,
        grants: [{ on: "table", name: "public.x", privileges: ["SELECT"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [{ on: "schema", name: "public", privileges: ["USAGE"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [{ on: "function", name: "ops.f; DROP", privileges: ["EXECUTE"], to: ["fin_api"] }],
      },
      {
        ...base,
        grants: [
          { on: "table", name: "ops.x", privileges: ["DELETE"], columns: ["a"], to: ["fin_api"] },
        ],
      },
      { ...base, extra: true },
      {
        ...base,
        grants: [{ on: "table", name: "ops.x", privileges: ["SELECT"], to: ["fin_api_a"] }],
      },
    ];
    for (const fragment of bad) {
      expect(codeOf(() => parseFragment("ops.json", JSON.stringify(fragment)))).toBe(
        "grants_invalid",
      );
    }
    expect(codeOf(() => parseFragment("ops.json", "{"))).toBe("grants_invalid");
  });

  it("normalises regprocedure text to the fragments' signature form", () => {
    expect(normaliseSignature("ops.enqueue_job(text,text,jsonb,timestamp with time zone)")).toBe(
      "ops.enqueue_job(text, text, jsonb, timestamptz)",
    );
    expect(normaliseSignature("audit.unsequenced_age()")).toBe("audit.unsequenced_age()");
  });
});
