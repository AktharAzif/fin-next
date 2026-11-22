// The renderer of each static output's `_headers` and `env.json` (spec 01 §7.4; SF-05, S0-05). A
// control path, Node built-ins and relative imports only. Builds are environment-neutral; the
// deploy (`pnpm fin static render`) renders both files into each artefact's copy from these
// profiles, the environment's settings and the overlay's hostnames, so production serves the bytes
// staging tested. The renderer checks its own output against the deploy's hostnames: the only
// origin a policy may name is the API host's, in the docs profile's connect-src.
import {
  ASSET_CACHE,
  OUTPUT_PROFILE,
  OUTPUT_ROLE,
  PROFILES,
  REPORTING_ENDPOINTS,
  type StaticOutput,
} from "./profiles.ts";

export type StaticEnvironment = "development" | "ci" | "staging" | "production";

export interface RenderInput {
  output: StaticOutput;
  environment: StaticEnvironment;
  /** The release's 40-hex commit SHA. */
  release: string;
  /** Host role to hostname (console, admin, verify, selfie, docs, api), from the overlay. */
  hosts: Readonly<Record<string, string>>;
}

export interface Rendered {
  headers: string;
  envJson: string;
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const ENVIRONMENTS: readonly StaticEnvironment[] = ["development", "ci", "staging", "production"];

function host(input: RenderInput, role: string): string {
  const value = input.hosts[role];
  if (value === undefined || !HOSTNAME.test(value)) {
    throw new Error(`the host map needs a valid hostname for the ${role} role`);
  }
  return value;
}

function validate(input: RenderInput): void {
  if (!Object.hasOwn(OUTPUT_PROFILE, input.output)) throw new Error("unknown static output");
  if (!ENVIRONMENTS.includes(input.environment)) throw new Error("unknown environment");
  if (!/^[0-9a-f]{40}$/.test(input.release)) throw new Error("the release must be a 40-hex SHA");
  host(input, OUTPUT_ROLE[input.output]);
}

/** HSTS by the zone's class (ARCHITECTURE §5.8): preload only on production's admin and hosted zones. */
export function hstsValue(environment: StaticEnvironment, output: StaticOutput): string {
  const preload =
    environment === "production" &&
    (output === "admin" || output === "verify" || output === "selfie");
  return `max-age=63072000; includeSubDomains${preload ? "; preload" : ""}`;
}

/** The page policy of an output, as one header value. */
export function contentSecurityPolicy(input: RenderInput): string {
  const profile = PROFILES[OUTPUT_PROFILE[input.output]];
  const api = input.output === "docs" ? `https://${host(input, "api")}` : "";
  const directives = profile.csp.map(([name, value]) => `${name} ${value.replace("{api}", api)}`);
  if (profile.reports) directives.push("report-to csp");
  return directives.join("; ");
}

/** Refuses a rendered policy that names anything but keywords and, for docs, the API origin. */
function assertOrigins(input: RenderInput, csp: string): void {
  const api = `https://${input.hosts.api ?? ""}`;
  for (const directive of csp.split(";")) {
    const [name = "", ...values] = directive.trim().split(/\s+/);
    for (const value of values) {
      if (name === "report-to" && value === "csp") continue;
      if (value === "'self'" || value === "'none'") continue;
      if (input.output === "docs" && name === "connect-src" && value === api) continue;
      throw new Error(`the ${input.output} policy names a source outside its profile`);
    }
  }
}

export function renderHeaders(input: RenderInput): string {
  validate(input);
  const profile = PROFILES[OUTPUT_PROFILE[input.output]];
  const csp = contentSecurityPolicy(input);
  assertOrigins(input, csp);
  const lines = ["/*", "  Cache-Control: no-cache", `  Content-Security-Policy: ${csp}`];
  if (profile.reports) lines.push(`  Reporting-Endpoints: ${REPORTING_ENDPOINTS}`);
  lines.push(
    `  Strict-Transport-Security: ${hstsValue(input.environment, input.output)}`,
    "  X-Content-Type-Options: nosniff",
    `  Referrer-Policy: ${profile.referrerPolicy}`,
    "  Cross-Origin-Opener-Policy: same-origin",
    "  Cross-Origin-Resource-Policy: same-origin",
    `  Permissions-Policy: ${profile.permissionsPolicy}`,
  );
  if (input.environment !== "production") lines.push("  X-Robots-Tag: noindex, nofollow");
  lines.push("/assets/*", "  ! Cache-Control", `  Cache-Control: ${ASSET_CACHE}`);
  return `${lines.join("\n")}\n`;
}

/**
 * env.json (spec 01 §7.4): one schema for every app. `apiOrigin` only on the docs site; Fin Admin's
 * origin is never a field, so it never appears in a public app's file.
 */
export function renderEnvJson(input: RenderInput): string {
  validate(input);
  const env: Record<string, string> = {
    environment: input.environment,
    release: input.release,
    docsOrigin: `https://${host(input, "docs")}`,
    consoleOrigin: `https://${host(input, "console")}`,
  };
  if (input.output === "docs") env.apiOrigin = `https://${host(input, "api")}`;
  return `${JSON.stringify(env, null, 2)}\n`;
}

export function renderStatic(input: RenderInput): Rendered {
  return { headers: renderHeaders(input), envJson: renderEnvJson(input) };
}
