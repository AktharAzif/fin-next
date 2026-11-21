// spec 01 §7.3: the renderer against the map, its refusals, and S-01's paths. When
// FIN_CLOUDFLARED_BIN names a cloudflared binary (CI's build job; locally the pinned 2026.11.1), the
// same URLs also go through `cloudflared tunnel ingress rule` and must pick the same rule.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError } from "@fin/core";
import { describe, expect, it } from "vitest";
import { loadConnectorConfig } from "./config.ts";
import { ALLOWED_TARGETS, CATCH_ALL, INGRESS_MAP } from "./map.ts";
import {
  buildRules,
  cloudflaredPath,
  matchRule,
  type RenderInput,
  renderConfig,
} from "./render.ts";

const ZONE = "staging.example.net";
const host = (label: string): string => `${label}.${ZONE}`;
const PUBLIC: RenderInput = {
  tunnel: "public",
  zone: ZONE,
  hosts: {
    api: host("gateway"),
    console: host("console"),
    verify: host("onboard"),
    selfie: host("selfie"),
  },
};
const ADMIN: RenderInput = {
  tunnel: "admin",
  zone: ZONE,
  hosts: { admin: host("staff") },
  access: { team: "fin-team", aud: "a".repeat(64) },
};

function refusal(input: RenderInput): string {
  try {
    buildRules(input);
    return "rendered";
  } catch (error) {
    if (error instanceof ConfigError) return `${error.variable}:${error.problem}`;
    throw error;
  }
}

describe("the map", () => {
  it("names roles and fixed targets only, and no rule for docs", () => {
    for (const entries of Object.values(INGRESS_MAP)) {
      for (const entry of entries) {
        expect(entry.service).toMatch(
          /^http:\/\/(edge|console|verify|admin)\.railway\.internal:8080$/,
        );
        if (entry.role !== "api") expect(entry.path).toBe("^/api/");
      }
    }
    expect(JSON.stringify(INGRESS_MAP)).not.toMatch(/payments|postgres|docs|api\.railway/);
    expect([...ALLOWED_TARGETS]).toContain(CATCH_ALL);
  });
});

describe("renderConfig", () => {
  it("renders the public tunnel exactly", () => {
    expect(renderConfig(PUBLIC).yaml).toBe(
      [
        "# Rendered at start by the connector supervisor from apps/connector/src/map.ts and",
        "# FIN_TUNNEL_HOSTS. Never edited; a change to the map is a reviewed image.",
        "ingress:",
        `  - hostname: "${host("gateway")}"`,
        '    service: "http://edge.railway.internal:8080"',
        "    originRequest:",
        `      httpHostHeader: "${host("gateway")}"`,
        `  - hostname: "${host("console")}"`,
        '    path: "^/api/"',
        '    service: "http://console.railway.internal:8080"',
        "    originRequest:",
        `      httpHostHeader: "${host("console")}"`,
        `  - hostname: "${host("onboard")}"`,
        '    path: "^/api/"',
        '    service: "http://verify.railway.internal:8080"',
        "    originRequest:",
        `      httpHostHeader: "${host("onboard")}"`,
        `  - hostname: "${host("selfie")}"`,
        '    path: "^/api/"',
        '    service: "http://verify.railway.internal:8080"',
        "    originRequest:",
        `      httpHostHeader: "${host("selfie")}"`,
        '  - service: "http_status:404"',
        "",
      ].join("\n"),
    );
  });

  it("renders the admin tunnel with Access required at the connector", () => {
    expect(renderConfig(ADMIN).yaml).toBe(
      [
        "# Rendered at start by the connector supervisor from apps/connector/src/map.ts and",
        "# FIN_TUNNEL_HOSTS. Never edited; a change to the map is a reviewed image.",
        "ingress:",
        `  - hostname: "${host("staff")}"`,
        '    path: "^/api/"',
        '    service: "http://admin.railway.internal:8080"',
        "    originRequest:",
        `      httpHostHeader: "${host("staff")}"`,
        "      access:",
        "        required: true",
        '        teamName: "fin-team"',
        "        audTag:",
        `          - "${"a".repeat(64)}"`,
        '  - service: "http_status:404"',
        "",
      ].join("\n"),
    );
  });

  it("refuses hosts outside FIN_ZONE, unknown or missing roles, duplicates and a missing Access", () => {
    expect(
      refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, api: "gateway.other.example.org" } }),
    ).toBe("FIN_TUNNEL_HOSTS:refused");
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, api: `a.b.${ZONE}` } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, api: ZONE } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, api: `evil${ZONE}` } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, docs: host("docs") } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, payments: host("pay") } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, admin: host("staff") } })).toBe(
      "FIN_TUNNEL_HOSTS:refused",
    );
    const { selfie: _selfie, ...withoutSelfie } = PUBLIC.hosts;
    expect(refusal({ ...PUBLIC, hosts: withoutSelfie })).toBe("FIN_TUNNEL_HOSTS:malformed");
    expect(refusal({ ...PUBLIC, hosts: { ...PUBLIC.hosts, selfie: host("onboard") } })).toBe(
      "FIN_TUNNEL_HOSTS:malformed",
    );
    const { access: _access, ...noAccess } = ADMIN;
    expect(refusal(noAccess)).toBe("FIN_ACCESS_TEAM:missing");
    expect(refusal({ ...PUBLIC, zone: "not a zone" })).toBe("FIN_ZONE:malformed");
  });

  it("refuses a role spelled __proto__ rather than losing it", () => {
    const config = loadConnectorConfig({
      FIN_SERVICE: "cloudflared-public",
      FIN_ENVIRONMENT: "ci",
      FIN_RELEASE: "a".repeat(40),
      FIN_DRAIN_SECONDS: "35",
      FIN_TUNNEL_ROLE: "public",
      FIN_ZONE: ZONE,
      FIN_TUNNEL_HOSTS: `{"__proto__":"${host("app")}",${JSON.stringify(PUBLIC.hosts).slice(1)}`,
      TUNNEL_TOKEN: `eyJhIjoi${"x".repeat(60)}`,
    });
    expect(Object.keys(config.hosts)).toContain("__proto__");
    expect(refusal({ ...PUBLIC, hosts: config.hosts })).toBe("FIN_TUNNEL_HOSTS:refused");
  });
});

// S-01 (g) and §11.2 check (j): the paths as the tunnel receives them. cloudflared matches the
// percent-decoded path and keeps dot segments, so an encoded or dotted alias of /api/ reaches the
// API half; the API half's ingress check then refuses it (400, packages/server isSafeTarget).
const S01: [string, string][] = [
  [`https://${host("console")}/api/x`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/api/auth/get-session`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/x/../api/y`, CATCH_ALL],
  [`https://${host("console")}//api/y`, CATCH_ALL],
  [`https://${host("console")}/API/x`, CATCH_ALL],
  [`https://${host("console")}/API/ping`, CATCH_ALL],
  [`https://${host("console")}/api`, CATCH_ALL],
  [`https://${host("console")}/apix`, CATCH_ALL],
  [`https://${host("console")}/api%2Fping`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/api%2fping`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/%61pi/ping`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/api%2F..%2Freadyz`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/api/../settings`, "http://console.railway.internal:8080"],
  [`https://${host("console")}/%2Fapi/x`, CATCH_ALL],
  [`https://${host("console")}/`, CATCH_ALL],
  [`https://${host("console")}/assets/a.js`, CATCH_ALL],
  [`https://${host("onboard")}/api/link/open`, "http://verify.railway.internal:8080"],
  [`https://${host("selfie")}/api/selfie/session`, "http://verify.railway.internal:8080"],
  [`https://${host("selfie")}/s`, CATCH_ALL],
  [`https://${host("gateway")}/v4/whoami`, "http://edge.railway.internal:8080"],
  [`https://${host("gateway")}/`, "http://edge.railway.internal:8080"],
  [`https://${host("docs")}/api/x`, CATCH_ALL],
  [`https://${host("staff")}/api/health`, CATCH_ALL],
  [`https://unknown.example.org/api/x`, CATCH_ALL],
];

describe("S-01's paths through the rendered public tunnel", () => {
  const rules = buildRules(PUBLIC);
  for (const [url, service] of S01) {
    it(`${new URL(url).host.split(".")[0]} ${url.replace(/^https:\/\/[^/]+/, "")} goes to ${service}`, () => {
      expect(matchRule(rules, url).service).toBe(service);
    });
  }

  it("never sends a path that is not /api/... on an app host to an app service", () => {
    const normalised = `https://${host("console")}${new URL(`https://${host("console")}/x/../api/y`).pathname}`;
    expect(matchRule(rules, normalised).service).toBe("http://console.railway.internal:8080");
  });

  it("decodes the path as cloudflared does, and refuses a malformed escape", () => {
    expect(cloudflaredPath("/api%2Fping")).toBe("/api/ping");
    expect(cloudflaredPath("/%61pi/%2e%2e/x")).toBe("/api/../x");
    expect(() => matchRule(rules, `https://${host("console")}/api%zz`)).toThrow("not a valid URL");
  });

  it("matches the admin tunnel's rule only for the staff host's /api/", () => {
    const admin = buildRules(ADMIN);
    expect(matchRule(admin, `https://${host("staff")}/api/health`).service).toBe(
      "http://admin.railway.internal:8080",
    );
    expect(matchRule(admin, `https://${host("staff")}/`).service).toBe(CATCH_ALL);
    expect(matchRule(admin, `https://${host("console")}/api/x`).service).toBe(CATCH_ALL);
  });
});

const binary = process.env.FIN_CLOUDFLARED_BIN;

describe.skipIf(binary === undefined || binary === "")(
  "cloudflared tunnel ingress rule agrees",
  () => {
    it("picks the same rule for every S-01 URL, and validates both configurations", () => {
      for (const input of [PUBLIC, ADMIN]) {
        const { rules, yaml } = renderConfig(input);
        const dir = mkdtempSync(join(tmpdir(), "fin-connector-"));
        const file = join(dir, "config.yml");
        writeFileSync(file, yaml);
        execFileSync(binary as string, ["tunnel", "--config", file, "ingress", "validate"], {
          stdio: "pipe",
        });
        for (const [url] of S01) {
          const out = execFileSync(
            binary as string,
            ["tunnel", "--config", file, "ingress", "rule", url],
            {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          const index = Number(/Matched rule #(\d+)/.exec(out)?.[1]);
          expect(rules[index], url).toEqual(matchRule(rules, url));
        }
      }
    });
  },
);
