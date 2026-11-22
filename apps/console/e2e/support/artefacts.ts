// node apps/console/e2e/support/artefacts.ts <dir>
//
// Writes what the deploy would render beside the console's static build for a journey run: the
// `app` profile's `_headers` (spec 01 §7.4, as the harness's own fixture renders it) and an
// env.json for the journey hosts, into <dir>/console/. The harness's static host reads them through
// FIN_E2E_RENDERED_DIR (packages/testing/src/playwright/config.ts). Nothing here is a deploy value:
// the origins are the journey hosts under `.localhost`, and the release is a test name.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const E2E_RELEASE = "e2e-release";

/** The `app` profile, rendered as the harness's fixture holds it (spec 01 §7.4). */
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

export function envJson(): string {
  return `${JSON.stringify(
    {
      environment: "ci",
      release: E2E_RELEASE,
      docsOrigin: "https://docs.localhost:4105",
      consoleOrigin: "https://console.localhost:4101",
    },
    null,
    2,
  )}\n`;
}

export function writeArtefacts(dir: string): string {
  const out = join(resolve(dir), "console");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "_headers"), APP_HEADERS);
  writeFileSync(join(out, "env.json"), envJson());
  return out;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (dir === undefined || dir === "") {
    process.stderr.write("usage: node apps/console/e2e/support/artefacts.ts <dir>\n");
    process.exit(64);
  }
  writeArtefacts(dir);
}
