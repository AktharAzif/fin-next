// The email sink's command line over a real socket, run as Playwright's webServer runs it: it
// answers on loopback and stamps each message at the run's clock (FIN_E2E_CLOCK, or --clock), the
// clock the other stand-ins sign at and the servers start from, never at the machine's own.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CANON_TIME } from "../src/clock.ts";
import { type Cli, runCli } from "./cli.ts";

const CLI = join(import.meta.dirname, "../src/email/cli.ts");

const MESSAGE = {
  from: "Fin <no-reply@auth.example.com>",
  to: ["asha.rao@example.com"],
  subject: "Your sign-in code",
  text: "Your code is 12345678. It works for 15 minutes.",
  template: "identity/sign-in-code",
};

interface Start {
  readonly event: string;
  readonly service: string;
  readonly origin: string;
  readonly clock: string;
}

describe("the email sink's command line", () => {
  const running: Cli[] = [];
  afterAll(async () => {
    await Promise.all(running.map((cli) => cli.stop()));
  });

  async function start(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<Start> {
    const cli = runCli(CLI, ["--port", "0", ...args], env);
    running.push(cli);
    return JSON.parse(await cli.line(0)) as Start;
  }

  /** Delivers a message as a `test` image's adapter would, and returns its stamp. */
  async function stampOf(origin: string): Promise<string | undefined> {
    const posted = await fetch(`${origin}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(MESSAGE),
    });
    expect(posted.status).toBe(201);
    const listed = (await (await fetch(`${origin}/messages`)).json()) as {
      messages: { receivedAt: string }[];
    };
    return listed.messages.at(-1)?.receivedAt;
  }

  it("stamps messages at the canon's time when no clock is given", async () => {
    const begun = await start([]);
    expect(begun).toMatchObject({
      event: "process.start",
      service: "email-sink",
      clock: CANON_TIME,
    });
    expect(begun.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await stampOf(begun.origin)).toBe(CANON_TIME);
  });

  it("stamps them at FIN_E2E_CLOCK, and at --clock over it", async () => {
    const env = { FIN_E2E_CLOCK: "2026-11-18T09:00:00+05:30" };
    const fromEnv = await start([], env);
    expect(fromEnv.clock).toBe("2026-11-18T03:30:00.000Z");
    expect(await stampOf(fromEnv.origin)).toBe("2026-11-18T03:30:00.000Z");
    const fromFlag = await start(["--clock", "2026-11-19T00:00:00Z"], env);
    expect(fromFlag.clock).toBe("2026-11-19T00:00:00.000Z");
    expect(await stampOf(fromFlag.origin)).toBe("2026-11-19T00:00:00.000Z");
  });

  it("stamps them at the system clock for 'wall'", async () => {
    const begun = await start(["--clock", "wall"]);
    expect(begun.clock).toBe("wall");
    const before = Date.now();
    const at = Date.parse((await stampOf(begun.origin)) ?? "");
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it.each([
    [["--port", "0", "--clock", "yesterday"], {}, "--clock"],
    [["--port", "0"], { FIN_E2E_CLOCK: "yesterday" }, "FIN_E2E_CLOCK"],
    [["--port", "nope"], {}, "--port"],
  ])("refuses %j %j with exit code 78, naming the setting", async (args, env, named) => {
    const bad = runCli(CLI, args, env);
    // Stopped after the tests should it start after all.
    running.push(bad);
    expect(await bad.exited()).toBe(78);
    expect(bad.stderr()).toContain(named);
  });
});
