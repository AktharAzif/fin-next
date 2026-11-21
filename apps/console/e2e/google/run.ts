// node apps/console/e2e/google/run.ts [playwright args...]   (after `pnpm --filter @fin/console build`)
//
// Runs Google's journey (`@google`) with what it needs that the root configuration leaves to the
// app's lane: the rendered `_headers` and env.json the deploy would upload; the fixture OpenID
// provider and the console's real API half with Google on (apps/console/test/google-journey.ts,
// in a process of its own); and a static host of the journey's own (playwright.google.config.ts).
// Every one of them is on the journey's own ports (support.ts), so a run never reuses a server
// another run on the same machine has up on the shared ones. Needs FIN_TEST_DATABASE_URL
// (Postgres 18) and the built console in dist/static. One worker: the provider's next choice is
// one setting for the run.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { writeArtefacts } from "../support/artefacts.ts";
import { GOOGLE_JOURNEY_PORTS, JOURNEY_RELEASE } from "./support.ts";

const APP_DIR = resolve(import.meta.dirname, "../..");
const RENDERED = join(APP_DIR, "dist", "e2e-rendered");
const ORIGIN = `https://console.localhost:${GOOGLE_JOURNEY_PORTS.static}`;
const ENV = {
  ...process.env,
  FIN_E2E_GOOGLE_CONSOLE_ORIGIN: ORIGIN,
  FIN_E2E_APPS: "console",
  FIN_E2E_RENDERED_DIR: RENDERED,
};

/** Starts the journey's servers and resolves once they say they are ready. */
function startServers(): Promise<ChildProcess> {
  const child = spawn("node", [join(APP_DIR, "test", "google-journey.ts")], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "inherit"],
    env: ENV,
  });
  return new Promise((done, fail) => {
    let seen = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes("google-journey: ready")) done(child);
    });
    child.on("exit", (code) => fail(new Error(`the journey's servers stopped (${code})`)));
    child.on("error", fail);
  });
}

async function main(): Promise<number> {
  const out = writeArtefacts(RENDERED);
  // The real API half reports a release in the commit-hash shape; env.json names the same one,
  // and the journey's own console origin.
  const env = JSON.parse(readFileSync(join(out, "env.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(
    join(out, "env.json"),
    `${JSON.stringify({ ...env, release: JOURNEY_RELEASE, consoleOrigin: ORIGIN }, null, 2)}\n`,
  );
  const servers = await startServers();
  try {
    const child = spawn(
      "pnpm",
      [
        "exec",
        "playwright",
        "test",
        "--config",
        join(import.meta.dirname, "playwright.google.config.ts"),
        "--workers=1",
        ...process.argv.slice(2),
      ],
      { cwd: APP_DIR, stdio: "inherit", env: ENV },
    );
    return await new Promise<number>((done) => {
      child.on("exit", (status) => done(status ?? 1));
      child.on("error", () => done(1));
    });
  } finally {
    if (servers.exitCode === null) {
      const stopped = new Promise((done) => servers.once("exit", done));
      servers.kill("SIGTERM");
      await stopped;
    }
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `e2e: ${error instanceof Error ? error.message : "could not start Google's journey"}\n`,
    );
    process.exit(1);
  },
);
