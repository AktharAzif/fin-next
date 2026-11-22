// The header-matrix test (spec 01 §7.4; FW-C05; [SA-45]; AC-P0-23's unit half). Every profile is
// rendered for every environment: the exact values, then the rules: 'unsafe-inline' only ever in the
// docs style-src exception (not yet granted, so nowhere), data: only ever in the docs img-src
// exception (nowhere yet), Sumsub's hosts only in selfie (none until Sunday), no ws: and no origin
// but the API's in docs connect-src. The repository's own static:check reads the same output.
// The eval guard holds whatever exception is granted later: default-src stays 'none' and neither
// script-src nor default-src carries an eval keyword, so no page can run code it builds from a
// string (eval, the Function constructor, a string passed to a timer); a planted copy of the profile
// table proves the guard fails when a profile adds one.
import { describe, expect, it, vi } from "vitest";
import { checkHeaders } from "../../../../scripts/static-check.mjs";
import {
  OUTPUT_PROFILE,
  PERMISSIONS_APP,
  PERMISSIONS_DENY_ALL,
  PROFILES,
  type Profile,
  type ProfileName,
  type StaticOutput,
} from "./profiles.ts";
import {
  contentSecurityPolicy,
  hstsValue,
  type RenderInput,
  renderEnvJson,
  renderHeaders,
} from "./render.ts";

const RELEASE = "0123456789abcdef0123456789abcdef01234567";
const HOSTS = {
  console: "console.staging.example.net",
  admin: "staff.staging.example.net",
  verify: "onboard.staging.example.net",
  selfie: "selfie.staging.example.net",
  docs: "docs.staging.example.net",
  api: "gateway.staging.example.net",
};
const OUTPUTS = Object.keys(OUTPUT_PROFILE) as StaticOutput[];
const ENVIRONMENTS = ["development", "ci", "staging", "production"] as const;

const input = (
  output: StaticOutput,
  environment: RenderInput["environment"] = "staging",
): RenderInput => ({
  output,
  environment,
  release: RELEASE,
  hosts: HOSTS,
});

function headerValues(text: string, path = "/*"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("/")) current = line;
    else if (current === path && line.startsWith("  ") && !line.startsWith("  !")) {
      const index = line.indexOf(":");
      const name = line.slice(2, index);
      out.set(name, [...(out.get(name) ?? []), line.slice(index + 2)]);
    }
  }
  return out;
}

describe("the app profile", () => {
  it("renders spec 01 §7.4's block for the console on staging, exactly", () => {
    expect(renderHeaders(input("console"))).toBe(
      [
        "/*",
        "  Cache-Control: no-cache",
        "  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; report-to csp",
        '  Reporting-Endpoints: csp="/api/monitoring/csp"',
        "  Strict-Transport-Security: max-age=63072000; includeSubDomains",
        "  X-Content-Type-Options: nosniff",
        "  Referrer-Policy: same-origin",
        "  Cross-Origin-Opener-Policy: same-origin",
        "  Cross-Origin-Resource-Policy: same-origin",
        "  Permissions-Policy: accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
        "  X-Robots-Tag: noindex, nofollow",
        "/assets/*",
        "  ! Cache-Control",
        "  Cache-Control: public, max-age=31536000, immutable",
        "",
      ].join("\n"),
    );
    expect(renderHeaders(input("admin"))).toBe(renderHeaders(input("console")));
  });
});

describe("the other profiles", () => {
  it("hosted and selfie differ from app only in the referrer and permissions policies", () => {
    for (const output of ["verify", "selfie"] as const) {
      const values = headerValues(renderHeaders(input(output)));
      expect(values.get("Referrer-Policy")).toEqual(["no-referrer"]);
      expect(values.get("Permissions-Policy")).toEqual([PERMISSIONS_DENY_ALL]);
      expect(values.get("Content-Security-Policy")).toEqual(
        headerValues(renderHeaders(input("console"))).get("Content-Security-Policy"),
      );
    }
  });

  it("docs adds the API origin for Try it, refuses forms, and has no report-to", () => {
    const values = headerValues(renderHeaders(input("docs")));
    expect(values.get("Content-Security-Policy")).toEqual([
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self' https://gateway.staging.example.net; manifest-src 'self'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    ]);
    expect(values.has("Reporting-Endpoints")).toBe(false);
    expect(values.get("Referrer-Policy")).toEqual(["no-referrer"]);
    expect(values.get("Permissions-Policy")).toEqual([PERMISSIONS_DENY_ALL]);
  });
});

describe("the matrix", () => {
  for (const environment of ENVIRONMENTS) {
    for (const output of OUTPUTS) {
      it(`${output} in ${environment} holds every rule`, () => {
        const text = renderHeaders(input(output, environment));
        const csp = contentSecurityPolicy(input(output, environment));
        expect(text).not.toMatch(/'unsafe-|data:|ws:|wss:|\*\.|sumsub|nonce-|'strict-dynamic'/i);
        expect(checkHeaders(`${output}/_headers`, text, output)).toEqual([]);
        const origins = [...csp.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]);
        expect(origins).toEqual(output === "docs" ? ["https://gateway.staging.example.net"] : []);
        const values = headerValues(text);
        expect(values.get("Strict-Transport-Security")).toEqual([hstsValue(environment, output)]);
        expect(values.has("X-Robots-Tag")).toBe(environment !== "production");
        expect(values.get("Cache-Control")).toEqual(["no-cache"]);
        expect(headerValues(text, "/assets/*").get("Cache-Control")).toEqual([
          "public, max-age=31536000, immutable",
        ]);
        expect(text).toContain("/assets/*\n  ! Cache-Control\n");
        expect(values.get("X-Content-Type-Options")).toEqual(["nosniff"]);
        expect(values.get("Cross-Origin-Opener-Policy")).toEqual(["same-origin"]);
        expect(values.get("Cross-Origin-Resource-Policy")).toEqual(["same-origin"]);
        expect(values.has("Reporting-Endpoints")).toBe(output !== "docs");
        expect(csp.includes("report-to csp")).toBe(output !== "docs");
        expect(csp).toContain("script-src 'self';");
        expect(csp).toContain("frame-ancestors 'none'");
        const permissions = values.get("Permissions-Policy")?.[0];
        expect(permissions).toBe(
          output === "console" || output === "admin" ? PERMISSIONS_APP : PERMISSIONS_DENY_ALL,
        );
      });
    }
  }

  it("preloads HSTS only on production's admin and hosted zones", () => {
    expect(hstsValue("production", "admin")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(hstsValue("production", "verify")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(hstsValue("production", "selfie")).toBe("max-age=63072000; includeSubDomains; preload");
    expect(hstsValue("production", "console")).toBe("max-age=63072000; includeSubDomains");
    expect(hstsValue("production", "docs")).toBe("max-age=63072000; includeSubDomains");
    expect(hstsValue("staging", "admin")).toBe("max-age=63072000; includeSubDomains");
  });

  it("refuses a bad host map, release or output, naming no value", () => {
    expect(() =>
      renderHeaders({ ...input("docs"), hosts: { ...HOSTS, api: "Not A Host" } }),
    ).toThrow(/api role/);
    expect(() => renderHeaders({ ...input("console"), release: "main" })).toThrow(/40-hex/);
    expect(() =>
      renderHeaders({ ...input("console"), output: "payments" as StaticOutput }),
    ).toThrow(/unknown/);
    const { console: _console, ...noConsole } = HOSTS;
    expect(() => renderEnvJson({ ...input("verify"), hosts: noConsole })).toThrow(/console role/);
  });
});

// A source that lets a page run code from a string: 'unsafe-eval' (eval, Function, string timers),
// 'wasm-unsafe-eval' (WebAssembly compiled at run time) and any other keyword ending in -eval', as
// 'trusted-types-eval' does. A policy's keywords match in any case, so this one does too.
const EVAL_SOURCE = /-eval'$/i;

/** What in one page policy breaks the eval guard; empty when the policy holds it. */
function evalFindings(policy: string): string[] {
  const directives = policy
    .split(";")
    .map((directive) => directive.trim().split(/[\t\n\f\r ]+/))
    .filter(([name]) => name !== "")
    .map(([name = "", ...sources]) => ({ name: name.toLowerCase(), sources }));
  const findings: string[] = [];
  if (!directives.some(({ name }) => name === "default-src")) findings.push("no default-src");
  for (const { name, sources } of directives) {
    if (name !== "default-src" && name !== "script-src") continue;
    if (
      name === "default-src" &&
      !(sources.length === 1 && sources[0]?.toLowerCase() === "'none'")
    ) {
      findings.push("default-src is not 'none'");
    }
    for (const source of sources) {
      if (EVAL_SOURCE.test(source)) findings.push(`${name} carries ${source}`);
    }
  }
  return findings;
}

const label = (output: StaticOutput, environment: RenderInput["environment"]): string =>
  `${OUTPUT_PROFILE[output]} (${output}) in ${environment}`;

/** The guard over every profile, rendered by `render` for every environment through each output. */
function evalGuard(render: (input: RenderInput) => string): string[] {
  return ENVIRONMENTS.flatMap((environment) =>
    OUTPUTS.flatMap((output) =>
      evalFindings(render(input(output, environment))).map(
        (finding) => `${label(output, environment)}: ${finding}`,
      ),
    ),
  );
}

/** Every Content-Security-Policy value in a rendered `_headers`, under any path, in any case. */
function policiesIn(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => /^\s+content-security-policy\s*:/i.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
}

type Csp = Profile["csp"];

/** render.ts loaded afresh over a copy of the profile table in which one profile's policy changed. */
async function renderWithPlanted(profile: ProfileName, change: (csp: Csp) => Csp) {
  const table: Record<ProfileName, Profile> = {
    ...PROFILES,
    [profile]: { ...PROFILES[profile], csp: change(PROFILES[profile].csp) },
  };
  vi.resetModules();
  vi.doMock("./profiles.ts", async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    PROFILES: Object.freeze(table),
  }));
  try {
    return await import("./render.ts");
  } finally {
    vi.doUnmock("./profiles.ts");
    vi.resetModules();
  }
}

const addSource =
  (directive: string, source: string) =>
  (csp: Csp): Csp =>
    csp.map(([name, value]) => [name, name === directive ? `${value} ${source}` : value] as const);
const setDirective =
  (directive: string, value: string) =>
  (csp: Csp): Csp =>
    csp.map(([name, current]) => [name, name === directive ? value : current] as const);
const dropDirective =
  (directive: string) =>
  (csp: Csp): Csp =>
    csp.filter(([name]) => name !== directive);

const PLANTS: readonly {
  name: string;
  profile: ProfileName;
  change: (csp: Csp) => Csp;
  findings: readonly string[];
}[] = [
  {
    name: "app adds 'unsafe-eval' to script-src",
    profile: "app",
    change: addSource("script-src", "'unsafe-eval'"),
    findings: ["script-src carries 'unsafe-eval'"],
  },
  {
    name: "hosted adds 'wasm-unsafe-eval' to script-src",
    profile: "hosted",
    change: addSource("script-src", "'wasm-unsafe-eval'"),
    findings: ["script-src carries 'wasm-unsafe-eval'"],
  },
  {
    name: "selfie adds 'Unsafe-Eval' to default-src",
    profile: "selfie",
    change: addSource("default-src", "'Unsafe-Eval'"),
    findings: ["default-src is not 'none'", "default-src carries 'Unsafe-Eval'"],
  },
  {
    name: "docs sets default-src to 'self'",
    profile: "docs",
    change: setDirective("default-src", "'self'"),
    findings: ["default-src is not 'none'"],
  },
  {
    name: "app drops default-src",
    profile: "app",
    change: dropDirective("default-src"),
    findings: ["no default-src"],
  },
];

describe("the eval guard", () => {
  it("renders every profile: app, hosted, selfie and docs", () => {
    const rendered = [...new Set(OUTPUTS.map((output) => OUTPUT_PROFILE[output]))].sort();
    expect(rendered).toEqual(["app", "docs", "hosted", "selfie"]);
    expect(rendered).toEqual(Object.keys(PROFILES).sort());
  });

  it("finds default-src 'none' and no eval keyword in every profile and environment", () => {
    expect(evalGuard(contentSecurityPolicy)).toEqual([]);
    for (const environment of ENVIRONMENTS) {
      for (const output of OUTPUTS) {
        // The policy guarded is the one the deploy writes, and the file carries no other.
        const rendered = input(output, environment);
        expect(policiesIn(renderHeaders(rendered))).toEqual([contentSecurityPolicy(rendered)]);
      }
    }
  });

  it.each(PLANTS)("fails when $name (a planted copy of the profile table)", async (plant) => {
    const planted = await renderWithPlanted(plant.profile, plant.change);
    const expected = ENVIRONMENTS.flatMap((environment) =>
      OUTPUTS.filter((output) => OUTPUT_PROFILE[output] === plant.profile).flatMap((output) =>
        plant.findings.map((finding) => `${label(output, environment)}: ${finding}`),
      ),
    );
    expect(expected.length).toBeGreaterThan(0);
    expect(evalGuard(planted.contentSecurityPolicy)).toEqual(expected);
    // The copy stays in the planted module: the real table still holds the guard.
    expect(evalGuard(contentSecurityPolicy)).toEqual([]);
  });
});

describe("env.json", () => {
  it("has one schema, apiOrigin on docs only, and never Fin Admin's origin", () => {
    for (const output of OUTPUTS) {
      const env = JSON.parse(renderEnvJson(input(output))) as Record<string, string>;
      expect(Object.keys(env).sort()).toEqual(
        output === "docs"
          ? ["apiOrigin", "consoleOrigin", "docsOrigin", "environment", "release"]
          : ["consoleOrigin", "docsOrigin", "environment", "release"],
      );
      expect(env).toMatchObject({
        environment: "staging",
        release: RELEASE,
        docsOrigin: "https://docs.staging.example.net",
        consoleOrigin: "https://console.staging.example.net",
      });
      expect(JSON.stringify(env)).not.toContain(HOSTS.admin);
    }
  });
});
