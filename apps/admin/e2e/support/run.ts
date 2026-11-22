// node e2e/support/run.ts [playwright args...]   (`pnpm --filter @fin/admin e2e`, after the build)
//
// Runs Fin Admin's journeys under the root Playwright configuration (@fin/testing's projects, the
// static host behind the Access stand-in, the email sink), with what that configuration leaves to
// the app's lane:
//   - the rendered `_headers` and `/env.json` the deploy would upload (the `app` profile of spec 01
//     §7.4, which packages/web-host/src/static renders once it is on main; a build writes neither);
//   - the API half's test server on the role's API port: the admin API stand-in, unless
//     FIN_E2E_ADMIN_API=external says the real one is already listening there;
//   - one worker: the journeys share one staff table, and the last-Admin rule is about all of it.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { appOrigin } from "@fin/testing";
import { startAdminApi } from "./server.ts";

const APP_DIR = resolve(import.meta.dirname, "../..");
const ROOT = resolve(APP_DIR, "../..");
const RENDERED = join(APP_DIR, "test-results", "rendered");

/** Spec 01 §7.4's `app` profile, as the deploy renders it for every console and Fin Admin path. */
export const APP_HEADERS = `/*
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; report-to csp
  Reporting-Endpoints: csp="/api/monitoring/csp"
  Strict-Transport-Security: max-age=63072000; includeSubDomains
  X-Content-Type-Options: nosniff
  Referrer-Policy: same-origin
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Resource-Policy: same-origin
  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)
  X-Robots-Tag: noindex, nofollow
/assets/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
`;

function render(): void {
  const dir = join(RENDERED, "admin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "_headers"), APP_HEADERS);
  writeFileSync(
    join(dir, "env.json"),
    `${JSON.stringify({
      environment: "ci",
      release: "e2e-release",
      docsOrigin: appOrigin("docs"),
      consoleOrigin: appOrigin("console"),
    })}\n`,
  );
}

async function main(): Promise<number> {
  render();
  const external = process.env.FIN_E2E_ADMIN_API === "external";
  const api = external ? null : await startAdminApi();
  const child = spawn(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      join(ROOT, "playwright.config.ts"),
      "--workers=1",
      ...process.argv.slice(2),
    ],
    {
      cwd: APP_DIR,
      stdio: "inherit",
      env: { ...process.env, FIN_E2E_APPS: "admin", FIN_E2E_RENDERED_DIR: RENDERED },
    },
  );
  const code = await new Promise<number>((done) => {
    child.on("exit", (status) => done(status ?? 1));
    child.on("error", () => done(1));
  });
  await api?.close();
  return code;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(
      `e2e: ${error instanceof Error ? error.message : "could not start the journeys"}\n`,
    );
    process.exit(1);
  },
);
