import { describe, expect, it } from "vitest";
import { MigrationError } from "./errors.ts";
import {
  MIGRATIONS_DIR,
  migrationsNotAfterMain,
  parseMigration,
  readMigrations,
} from "./migrations.ts";

const HEADER = "SET LOCAL lock_timeout = '5s';\nSET LOCAL statement_timeout = '60s';\n";

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof MigrationError) return error.code;
    throw error;
  }
  return "none";
}

describe("migration files", () => {
  it("reads Phase 0's files in spec 01 §6.10's order", () => {
    const names = readMigrations(MIGRATIONS_DIR).map((f) => f.name.replace(/^\d{14}_/, ""));
    expect(names).toEqual([
      "audit_core.sql",
      "audit_journal.sql",
      "ops_core.sql",
      "email_outbox.sql",
      "events_shell.sql",
    ]);
  });

  it("checksums each file's bytes with SHA-256", () => {
    const a = parseMigration("20261121101000_ops_a.sql", Buffer.from(`${HEADER}SELECT 1;`));
    const b = parseMigration("20261121101000_ops_a.sql", Buffer.from(`${HEADER}SELECT 2;`));
    expect(a.checksum.byteLength).toBe(32);
    expect(a.checksum.equals(b.checksum)).toBe(false);
  });

  it("refuses a name that is not <YYYYMMDDHHMMSS>_<area>_<what>.sql with a real time", () => {
    for (const bad of [
      "0001_init.sql",
      "20261121101000_init.sql",
      "20261121101000_Ops_core.sql",
      "20261131101000_ops_core.sql",
      "20261121246000_ops_core.sql",
      "20251121101000_ops_core.sql",
      "20261121101000_ops_core.SQL",
    ]) {
      expect(codeOf(() => parseMigration(bad, Buffer.from(HEADER)))).toBe("migration_name");
    }
  });

  it("requires both timeouts first in a transactional file", () => {
    expect(codeOf(() => parseMigration("20261121101000_ops_a.sql", Buffer.from("SELECT 1;")))).toBe(
      "migration_timeouts",
    );
    expect(
      codeOf(() =>
        parseMigration(
          "20261121101000_ops_a.sql",
          Buffer.from(
            "SET LOCAL lock_timeout = '5s';\nSELECT 1;\nSET LOCAL statement_timeout = '1s';",
          ),
        ),
      ),
    ).toBe("migration_timeouts");
    expect(
      parseMigration(
        "20261121101000_ops_a.sql",
        Buffer.from(`-- a comment first is fine\n${HEADER}SELECT 1;`),
      ).transactional,
    ).toBe(true);
  });

  it("allows a non-transactional file holding exactly one statement", () => {
    const one = parseMigration(
      "20261121101000_ops_index.sql",
      Buffer.from("-- fin:non-transactional\nCREATE INDEX CONCURRENTLY x ON ops.job (id);\n"),
    );
    expect(one.transactional).toBe(false);
    expect(
      codeOf(() =>
        parseMigration(
          "20261121101000_ops_index.sql",
          Buffer.from("-- fin:non-transactional\nSELECT 1;\nSELECT 2;\n"),
        ),
      ),
    ).toBe("migration_non_transactional");
  });

  it("refuses CR line endings, so a checksum never depends on a checkout", () => {
    expect(
      codeOf(() =>
        parseMigration("20261121101000_ops_a.sql", Buffer.from(HEADER.replace(/\n/g, "\r\n"))),
      ),
    ).toBe("migration_line_endings");
  });
});

describe("migrationsNotAfterMain (the CI order check)", () => {
  it("refuses a new file whose name is not later than the newest on main", () => {
    const main = ["20261121101000_audit_core.sql", "20261121120000_identity_core.sql"];
    expect(
      migrationsNotAfterMain(
        [...main, "20261121110000_staff_core.sql", "20261121130000_kyc_core.sql"],
        main,
      ),
    ).toEqual(["20261121110000_staff_core.sql"]);
    expect(migrationsNotAfterMain(main, main)).toEqual([]);
    expect(migrationsNotAfterMain(["20261121090000_ops_x.sql"], [])).toEqual([]);
  });
});
