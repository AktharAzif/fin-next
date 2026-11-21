import { describe, expect, it } from "vitest";
import { stdoutLines } from "./lines.ts";
import { EXIT_CONFIG, EXIT_USAGE, parseArgs, runMigrateCli, UsageError } from "./main.ts";

const clock = { now: () => Date.UTC(2026, 10, 21, 12) };
// Built at run time: the public-safety check refuses credential-shaped URLs in tracked files.
const SECRET = ["not", "a", "real", "password"].join("-");
const URL_WITH_SECRET = [
  "postgresql://postgres:",
  SECRET,
  "@postgres.railway.internal:5432/railway",
].join("");
const RELEASE = "a".repeat(40);

async function run(
  argv: string[],
  env: Record<string, string>,
): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runMigrateCli(argv, env, {
    stdout: (text) => {
      out += text;
    },
    clock,
  });
  return { code, out };
}

describe("parseArgs", () => {
  it("takes exactly one mode", () => {
    expect(parseArgs(["--bootstrap"])).toEqual({ mode: "bootstrap" });
    expect(parseArgs(["--migrate"])).toEqual({ mode: "migrate" });
    expect(parseArgs(["--print-db-cert"])).toEqual({ mode: "print-db-cert" });
    expect(parseArgs(["--task", "audit-note"])).toEqual({ mode: "task", task: "audit-note" });
    for (const bad of [
      [],
      ["--migrate", "--bootstrap"],
      ["--task"],
      ["--task", "Bad Name"],
      ["--drop-everything"],
    ]) {
      expect(() => parseArgs(bad)).toThrow(UsageError);
    }
  });
});

describe("runMigrateCli's refusals", () => {
  it("exits 64 on a usage error", async () => {
    expect((await run(["--nope"], {})).code).toBe(EXIT_USAGE);
  });

  it("exits 78 naming a missing variable, never a value", async () => {
    const { code, out } = await run(["--migrate"], {
      FIN_ENVIRONMENT: "staging",
      FIN_BOOTSTRAP_DATABASE_URL: URL_WITH_SECRET,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(JSON.parse(out.trim())).toMatchObject({
      event: "migrate.failed",
      code: "config",
      variable: "FIN_RELEASE",
    });
    expect(out).not.toContain(SECRET);
  });

  it("refuses a staging run without the pinned CA, and a release that is not a commit SHA", async () => {
    const missingCa = await run(["--migrate"], {
      FIN_ENVIRONMENT: "staging",
      FIN_RELEASE: RELEASE,
      FIN_BOOTSTRAP_DATABASE_URL: URL_WITH_SECRET,
    });
    expect(missingCa.code).toBe(EXIT_CONFIG);
    const lines = missingCa.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.event)).toEqual(["migrate.started", "migrate.failed"]);
    expect(lines[1]).toMatchObject({
      code: "config",
      variable: "FIN_DB_CA_PEM",
      service: "migrate",
      release: RELEASE,
    });
    expect(missingCa.out).not.toContain(SECRET);

    const badRelease = await run(["--migrate"], {
      FIN_ENVIRONMENT: "staging",
      FIN_RELEASE: "main",
    });
    expect(badRelease.code).toBe(EXIT_CONFIG);
  });

  it("refuses a superuser URL that carries parameters", async () => {
    const { code, out } = await run(["--migrate"], {
      FIN_ENVIRONMENT: "ci",
      FIN_RELEASE: "test",
      FIN_BOOTSTRAP_DATABASE_URL: `${URL_WITH_SECRET}?sslmode=disable`,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('"variable":"FIN_BOOTSTRAP_DATABASE_URL"');
    expect(out).not.toContain(SECRET);
  });

  it("refuses FIN_ROLE_VERIFIERS holding a plaintext password, without echoing it", async () => {
    const verifiers = JSON.stringify({ fin_api_a: SECRET });
    const { code, out } = await run(["--bootstrap"], {
      FIN_ENVIRONMENT: "ci",
      FIN_RELEASE: "test",
      FIN_BOOTSTRAP_DATABASE_URL: ["postgresql://postgres:", SECRET, "@127.0.0.1:5432/db"].join(""),
      FIN_ROLE_VERIFIERS: verifiers,
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('"code":"bootstrap_verifiers"');
    expect(out).not.toContain(SECRET);
  });

  it("requires a run ID for a task (the audit actor)", async () => {
    const { code, out } = await run(["--task", "audit-note"], {
      FIN_ENVIRONMENT: "ci",
      FIN_RELEASE: "test",
      FIN_BOOTSTRAP_DATABASE_URL: ["postgresql://postgres:", SECRET, "@127.0.0.1:5432/db"].join(""),
    });
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('"event":"task.failed"');
  });
});

describe("the migrate lines", () => {
  it("carry the envelope and the fields, one JSON object per line", () => {
    let out = "";
    const sink = stdoutLines(
      { environment: "staging", release: RELEASE, replica: "r1", runId: "run_1" },
      clock,
      (t) => {
        out += t;
      },
    );
    sink.write({ event: "migrate.done", level: "info", fields: { mode: "migrate", applied: 2 } });
    expect(out.endsWith("\n")).toBe(true);
    expect(JSON.parse(out)).toEqual({
      dt: "2026-11-21T12:00:00.000Z",
      message: "migrate.done",
      event: "migrate.done",
      level: "info",
      service: "migrate",
      environment: "staging",
      release: RELEASE,
      replica: "r1",
      runId: "run_1",
      mode: "migrate",
      applied: 2,
    });
  });
});
