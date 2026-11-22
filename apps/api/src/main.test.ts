// The image's start commands (spec 01 §6.2, §6.6): no flag runs `api`, `--worker` the worker, and
// `--migrate`, `--bootstrap`, `--print-db-cert` and `--task <name>` the migrate CLI. Each is reached
// through its entry's own injection points (runService's options, the migrate CLI's environment, clock
// and output); anything else exits 64 with one line that names only the mode.
import { ConfigError } from "@fin/core";
import { SEAM_VARIABLES } from "@fin/server";
import { baseEnv, type Line } from "@fin/server/testing";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATE_FLAGS, main, refuseAtStart, selectEntry, USAGE } from "./main.ts";

const NOW = Date.UTC(2026, 10, 21, 12);
const clock = { now: () => NOW };
const DOCS_ORIGIN = "https://docs.example.net";

/** Runs `main` the way `migrate` and a refusal run, keeping what it writes and the exit. */
async function run(argv: string[], env: Record<string, string> = {}) {
  let out = "";
  const exits: number[] = [];
  const running = await main(argv, {
    env,
    clock,
    write: (text) => {
      out += text;
    },
    exit: (code) => exits.push(code),
  });
  const lines = out
    .trim()
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { running, out, exits, lines };
}

const started: NonNullable<Awaited<ReturnType<typeof main>>>[] = [];

/** Runs `main` the way `api` and `worker` run: runService on port 0, its lines kept. */
async function serve(argv: string[], env: Record<string, string>) {
  const stdout: Line[] = [];
  const exits: number[] = [];
  const running = await main(argv, {
    exit: () => {
      throw new Error("api and worker exit through runService, never main's exit");
    },
    write: () => {
      throw new Error("api and worker write through runService, never main's writer");
    },
    run: {
      env,
      exit: (code) => exits.push(code),
      processHandlers: false,
      host: "127.0.0.1",
      port: 0,
      stdout: (text) => stdout.push(JSON.parse(text) as Line),
    },
  });
  if (running !== undefined) started.push(running);
  return { running, stdout, exits };
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.shutdown.begin("SIGTERM")));
}, 20_000);

describe("selectEntry", () => {
  it("runs api with no flag, the worker with --worker alone, and migrate with its CLI's forms", () => {
    expect(selectEntry([])).toEqual({ entry: "api" });
    expect(selectEntry(["--worker"])).toEqual({ entry: "worker" });
    for (const argv of [
      ["--migrate"],
      ["--bootstrap"],
      ["--print-db-cert"],
      ["--task", "staff-bootstrap"],
      ["--task", "audit-note"],
    ]) {
      expect(selectEntry(argv), argv.join(" ")).toEqual({ entry: "migrate" });
    }
    expect(MIGRATE_FLAGS).toEqual(["--migrate", "--bootstrap", "--print-db-cert", "--task"]);
  });

  it("refuses an unknown flag, a missing or malformed argument, and anything extra", () => {
    for (const [argv, mode] of [
      [["--anything"], "unknown"],
      [["worker"], "unknown"],
      [["--"], "unknown"],
      [["--Worker"], "unknown"],
      [["--worker", "--migrate"], "worker"],
      [["--worker", "x"], "worker"],
      [["--task"], "task"],
      [["--task", "Bad Name"], "task"],
      [["--task", "a", "b"], "task"],
      [["--migrate", "--bootstrap"], "migrate"],
      [["--bootstrap", "now"], "bootstrap"],
      [["--print-db-cert", "--worker"], "print-db-cert"],
    ] as const) {
      expect(selectEntry(argv), argv.join(" ")).toEqual({ refused: mode });
    }
  });
});

describe("a refused start command", () => {
  it("exits 64 with one process.mode_refused line naming only the mode, and runs nothing", async () => {
    // Built at run time: whatever a start command carries is never echoed.
    const secret = ["never", "echoed", "value"].join("-");
    for (const [argv, mode] of [
      [["--anything"], "unknown"],
      [[`--${secret}`], "unknown"],
      [["--task"], "task"],
      [["--task", `${secret} with spaces`], "task"],
      [["--worker", secret], "worker"],
      [["--migrate", secret], "migrate"],
    ] as const) {
      const { running, out, exits, lines } = await run([...argv]);
      expect(running).toBeUndefined();
      expect(exits, argv.join(" ")).toEqual([64]);
      expect(lines).toEqual([
        {
          dt: "2026-11-21T12:00:00.000Z",
          message: "process.mode_refused",
          event: "process.mode_refused",
          level: "error",
          mode,
          usage: USAGE,
        },
      ]);
      expect(out).not.toContain(secret);
    }
  });
});

describe("the migrate flags", () => {
  // Enough for the CLI to start a mode; each then stops at the first variable its mode needs.
  const env = { FIN_ENVIRONMENT: "ci", FIN_RELEASE: "release-under-test" };

  it("reach the migrate CLI with main's environment, clock and writer, and exit with its code", async () => {
    for (const [argv, mode, variable] of [
      [["--migrate"], "migrate", "FIN_BOOTSTRAP_DATABASE_URL"],
      [["--bootstrap"], "bootstrap", "FIN_BOOTSTRAP_DATABASE_URL"],
      [["--print-db-cert"], "print-db-cert", "FIN_DB_HOST"],
    ] as const) {
      const { running, exits, lines } = await run([...argv], env);
      expect(running).toBeUndefined();
      expect(exits, mode).toEqual([78]);
      expect(lines.map((l) => l.event)).toEqual(["migrate.started", "migrate.failed"]);
      expect(lines[0]).toMatchObject({
        dt: "2026-11-21T12:00:00.000Z",
        service: "migrate",
        environment: "ci",
        release: "release-under-test",
        mode,
      });
      expect(lines[1]).toMatchObject({ mode, code: "config", variable });
    }
  });

  it("runs --task <name> as an operator task", async () => {
    const { exits, lines } = await run(["--task", "audit-note"], env);
    // A task needs its run ID (the audit actor) before anything else.
    expect(exits).toEqual([78]);
    expect(lines.map((l) => l.event)).toEqual(["migrate.started", "task.failed"]);
    expect(lines[0]).toMatchObject({ mode: "task", task: "audit-note" });
    expect(lines[1]).toMatchObject({ task: "audit-note", code: "config" });
  });

  it("take every process's start-up refusals first, naming the variable and running nothing", async () => {
    // Built at run time: a refused setting's value is never echoed.
    const value = ["never", "echoed", "setting"].join("-");
    for (const argv of [
      ["--migrate"],
      ["--bootstrap"],
      ["--print-db-cert"],
      ["--task", "audit-note"],
    ]) {
      for (const [extra, variable] of [
        [{ NODE_OPTIONS: `--require=${value}` }, "NODE_OPTIONS"],
        [{ BETTER_AUTH_URL: `https://${value}.example.com` }, "BETTER_AUTH_URL"],
        // Vitest runs the source, which refuses a deployed environment as the test build does.
        [{ FIN_ENVIRONMENT: "staging" }, "FIN_ENVIRONMENT"],
        [{ FIN_ENVIRONMENT: "production" }, "FIN_ENVIRONMENT"],
        [{ FIN_CONTAINER: "1", FIN_ENVIRONMENT: "development" }, "FIN_ENVIRONMENT"],
      ] as const) {
        const { running, out, exits, lines } = await run([...argv], { ...env, ...extra });
        const label = `${argv.join(" ")} ${variable}`;
        expect(running, label).toBeUndefined();
        expect(exits, label).toEqual([78]);
        expect(lines, label).toEqual([
          {
            dt: "2026-11-21T12:00:00.000Z",
            message: "config.invalid",
            event: "config.invalid",
            level: "error",
            variable,
            problem: "refused",
          },
        ]);
        expect(out, label).not.toContain(value);
      }
    }
  });

  it("refuse a seam in a release build and a test build in staging or production", () => {
    const refusal = (env: Record<string, string>, target: "release" | "test") => {
      try {
        refuseAtStart(env, target);
        return null;
      } catch (error) {
        if (error instanceof ConfigError) return `${error.variable} ${error.problem}`;
        throw error;
      }
    };
    for (const seam of SEAM_VARIABLES) {
      expect(refusal({ ...env, [seam]: "1" }, "release"), seam).toBe(`${seam} refused`);
    }
    expect(refusal({ ...env, fin_seam_clock: "1" }, "release")).toBe("FIN_SEAM refused");
    expect(refusal({ ...env, FIN_ENVIRONMENT: "production" }, "release")).toBeNull();
    expect(refusal({ ...env, FIN_ENVIRONMENT: "staging" }, "test")).toBe("FIN_ENVIRONMENT refused");
    expect(refusal({ ...env, FIN_SEAM_CLOCK: "1" }, "test")).toBeNull();
    expect(refusal({ ...env, FIN_CONTAINER: "1" }, "release")).toBeNull();
  });

  it("reads main's environment, never the process's", async () => {
    const { exits, lines } = await run(["--migrate"], {});
    expect(exits).toEqual([78]);
    expect(lines).toEqual([
      expect.objectContaining({
        event: "migrate.failed",
        mode: "migrate",
        code: "config",
        variable: "FIN_ENVIRONMENT",
      }),
    ]);
  });
});

describe("--worker", () => {
  it("reaches the worker's entry: it runs only as worker, and reads the worker's own settings", async () => {
    // As api, the worker's entry refuses to start.
    const asApi = await serve(["--worker"], baseEnv("api", { FIN_DOCS_ORIGIN: DOCS_ORIGIN }));
    expect(asApi.running).toBeUndefined();
    expect(asApi.exits).toEqual([78]);
    expect(asApi.stdout).toEqual([
      expect.objectContaining({ event: "config.invalid", variable: "FIN_SERVICE" }),
    ]);

    // As worker, it reads the email settings, which only the worker holds, and names each bad one.
    const worker = await serve(
      ["--worker"],
      baseEnv("worker", { FIN_DOCS_ORIGIN: DOCS_ORIGIN, FIN_EMAIL_FROM: "not-an-address" }),
    );
    expect(worker.running).toBeUndefined();
    expect(worker.exits).toEqual([78]);
    const invalid = worker.stdout.filter((l) => l.event === "config.invalid");
    expect(invalid.map((l) => l.variable)).toEqual(
      expect.arrayContaining([
        "FIN_EMAIL_TOKEN",
        "FIN_EMAIL_ACCOUNT_ID",
        "FIN_EMAIL_FROM",
        "FIN_EMAIL_LINK_ORIGINS",
        "FIN_SEED_INBOX",
        "FIN_LIMIT_KEY_IN_USE",
      ]),
    );
    expect(invalid.find((l) => l.variable === "FIN_EMAIL_FROM")).toMatchObject({
      problem: "malformed",
      service: "worker",
    });
    expect(invalid.find((l) => l.variable === "FIN_EMAIL_TOKEN")).toMatchObject({
      problem: "missing",
    });
    expect(JSON.stringify(worker.stdout)).not.toContain("not-an-address");
  });

  it("refuses the worker without its database login, naming the variable before any connection", async () => {
    const limitKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const token = ["unused", "token", "for", "a", "refused", "start"].join("-");
    const { running, exits, stdout } = await serve(
      ["--worker"],
      baseEnv("worker", {
        FIN_DOCS_ORIGIN: DOCS_ORIGIN,
        FIN_EMAIL_TOKEN: token,
        FIN_EMAIL_ACCOUNT_ID: "ef".repeat(16),
        FIN_EMAIL_FROM: "account-security@auth.example.com",
        FIN_EMAIL_LINK_ORIGINS: JSON.stringify({ console: "https://console.example.com" }),
        FIN_SEED_INBOX: "seed@example.net",
        FIN_LIMIT_KEY_IN_USE: "1",
        FIN_LIMIT_KEY_1: limitKey,
        FIN_DB_HOST: "postgres.railway.internal",
        FIN_DB_PORT: "5432",
        FIN_DB_NAME: "railway",
        FIN_DB_USER: "fin_api_a",
        FIN_DB_PASSWORD: limitKey,
      }),
    );
    expect(running).toBeUndefined();
    expect(exits).toEqual([78]);
    // The api's login is not one of the worker's.
    expect(stdout).toEqual([
      expect.objectContaining({
        event: "config.invalid",
        service: "worker",
        variable: "FIN_DB_USER",
        problem: "malformed",
      }),
    ]);
    const text = JSON.stringify(stdout);
    for (const value of [token, limitKey, "seed@example.net"]) expect(text).not.toContain(value);
  });
});

describe("no flag", () => {
  it("runs api exactly as before: its private health, every other call an outside request", async () => {
    const { running, stdout, exits } = await serve(
      [],
      baseEnv("api", { FIN_DOCS_ORIGIN: DOCS_ORIGIN, FIN_DRAIN_SECONDS: "5" }),
    );
    if (running === undefined) throw new Error(`api did not start: ${JSON.stringify(stdout)}`);
    expect(exits).toEqual([]);
    expect(stdout.find((l) => l.event === "process.start")).toMatchObject({ service: "api" });
    const health = await fetch(`http://127.0.0.1:${running.port}/healthz`);
    expect(await health.json()).toEqual({ status: "ok" });
    const ready = await fetch(`http://127.0.0.1:${running.port}/readyz`);
    expect(ready.status).toBe(200);
    const outside = await fetch(`http://127.0.0.1:${running.port}/internal/v4/customers`);
    expect(outside.status).toBe(403);
    expect(stdout.filter((l) => l.event === "api.outside_request")).toHaveLength(1);
  }, 20_000);

  it("refuses to run api as the worker", async () => {
    const { running, exits, stdout } = await serve(
      [],
      baseEnv("worker", { FIN_DOCS_ORIGIN: DOCS_ORIGIN }),
    );
    expect(running).toBeUndefined();
    expect(exits).toEqual([78]);
    expect(stdout).toEqual([
      expect.objectContaining({ event: "config.invalid", variable: "FIN_SERVICE" }),
    ]);
  });
});
