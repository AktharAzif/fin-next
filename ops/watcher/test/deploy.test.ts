import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BundleError, bundle, rewriteImports } from "../deploy/bundle.ts";
import {
  DeployError,
  NoAnswerError,
  type WatcherDeployContext,
  watcherDeploy,
} from "../deploy/deploy.ts";
import { ACCOUNT, EGRESS, HOSTS, healthyWorld, settingsFor, ZONE } from "./world.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "fin-watcher-test-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SECRETS = {
  operator: ["operator", "token", "one"].join("-"),
  read: ["read", "token", "two"].join("-"),
  telemetry: ["telemetry", "token", "three"].join("-"),
  uptime: ["uptime", "token", "four"].join("-"),
  source: ["source", "ingest", "five"].join("-"),
  host: "ingest-host.example.com",
  heartbeat: "https://heartbeat.example.com/beat/six",
};

function file(name: string, value: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `${value}\n`);
  return path;
}

const environ = {
  FIN_CLOUDFLARE_OPERATOR_TOKEN_FILE: file("op", SECRETS.operator),
  FIN_WATCHER_CF_TOKEN_FILE: file("read", SECRETS.read),
  FIN_BETTERSTACK_TELEMETRY_TOKEN_FILE: file("tel", SECRETS.telemetry),
  FIN_BETTERSTACK_UPTIME_TOKEN_FILE: file("up", SECRETS.uptime),
};

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

const NOW = new Date(Date.UTC(2026, 10, 21, 12));
const TOKEN_ID = ["token", "id", "seven"].join("-");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

interface FakeOptions {
  team?: string;
  extraBinding?: boolean;
  /** The watcher token's permission groups, as Cloudflare names them. */
  groups?: string[];
  status?: string;
  expiresOn?: string | null;
  duplicateSource?: boolean;
}

function fakeApis(options: FakeOptions = {}) {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method: init?.method ?? "GET", url: input, body: init?.body, auth });
    const team = options.team ?? "fin-staging";
    if (url.hostname === "telemetry.betterstack.com") {
      const source = {
        id: "1",
        type: "source",
        attributes: {
          name: "fin-next-staging-watcher",
          team_name: team,
          token: SECRETS.source,
          ingesting_host: SECRETS.host,
        },
      };
      return json({
        data: options.duplicateSource ? [source, { ...source, id: "9" }] : [source],
        pagination: { next: null },
      });
    }
    if (url.hostname === "incidents.betterstack.com") {
      return json({
        data: [
          {
            id: "2",
            type: "heartbeat",
            attributes: { name: "watcher", team_name: team, url: SECRETS.heartbeat },
          },
        ],
        pagination: { next: null },
      });
    }
    const path = url.pathname.replace("/client/v4", "");
    const base = `/accounts/${ACCOUNT}/workers/scripts`;
    const ok = (result: unknown) => json({ success: true, errors: [], result });
    const refused = () => json({ success: false, errors: [{ code: 1000 }] }, 401);
    // The token endpoints answer each token for itself: the Worker's verifies itself, and only
    // the operator's may read another token's permissions.
    if (path === `/accounts/${ACCOUNT}/tokens/verify`) {
      if (auth !== `Bearer ${SECRETS.read}` && auth !== `Bearer ${SECRETS.operator}`) {
        return refused();
      }
      const id = auth === `Bearer ${SECRETS.read}` ? TOKEN_ID : "operator-id";
      return ok({ id, status: options.status ?? "active" });
    }
    if (path === `/accounts/${ACCOUNT}/tokens/${TOKEN_ID}`) {
      if (auth !== `Bearer ${SECRETS.operator}`) return refused();
      const groups = options.groups ?? [
        "Zone Read",
        "DNS Read",
        "Workers Scripts Read",
        "Access: Apps and Policies Read",
      ];
      const expires = options.expiresOn === undefined ? inDays(90) : options.expiresOn;
      return ok({
        id: TOKEN_ID,
        status: options.status ?? "active",
        policies: [
          { effect: "allow", permission_groups: groups.map((name, i) => ({ id: `g${i}`, name })) },
        ],
        ...(expires === null ? {} : { expires_on: expires }),
      });
    }
    if (path === `/accounts/${ACCOUNT}/tokens/operator-id`) {
      return ok({
        id: "operator-id",
        policies: [{ effect: "allow", permission_groups: [{ name: "Workers Scripts Write" }] }],
        expires_on: inDays(1),
      });
    }
    if (init?.method === "PUT" || init?.method === "POST") return ok({});
    if (path === base) {
      return ok([{ id: "fin-next-staging-watcher", has_modules: true, handlers: ["scheduled"] }]);
    }
    if (path === `${base}/fin-next-staging-watcher/settings`) {
      const bindings = [
        { type: "plain_text", name: "FIN_WATCHER_SETTINGS" },
        ...[
          "FIN_CF_TOKEN",
          "FIN_TELEMETRY_HOST",
          "FIN_TELEMETRY_TOKEN",
          "FIN_HEARTBEAT_WATCHER_URL",
        ].map((name) => ({ type: "secret_text", name })),
        ...(options.extraBinding ? [{ type: "kv_namespace", name: "STATE" }] : []),
      ];
      return ok({ bindings });
    }
    if (path === `${base}/fin-next-staging-watcher/schedules`)
      return ok({ schedules: [{ cron: "* * * * *" }] });
    if (path === `${base}/fin-next-staging-watcher/subdomain`)
      return ok({ enabled: false, previews_enabled: false });
    return json({ success: false, errors: [{ code: 7003 }] }, 404);
  };
  return { calls, fetch };
}

async function context(fetch: WatcherDeployContext["fetch"], args: string[] = []) {
  const settings = await settingsFor(healthyWorld());
  const output: string[] = [];
  const ctx: WatcherDeployContext = {
    env: "staging",
    args,
    root: ROOT,
    accountId: ACCOUNT,
    zone: ZONE,
    hosts: HOSTS,
    staticEgress: EGRESS,
    registered: {
      rulesetHashes: settings.rulesetHashes,
      accessPolicyHash: settings.accessPolicyHash,
      staticVersions: settings.staticVersions,
    },
    release: "e".repeat(40),
    environ,
    stdout: { write: (t) => output.push(t) },
    now: () => NOW,
    ...(fetch === undefined ? {} : { fetch }),
  };
  return { ctx, output };
}

const cloudflareCalls = (calls: Call[]) =>
  calls.filter((c) => new URL(c.url).hostname === "api.cloudflare.com");

function expectNothingPrivate(output: string[]) {
  const text = output.join("");
  for (const value of [...Object.values(SECRETS), ZONE, ACCOUNT, ...Object.values(HOSTS)]) {
    expect(text).not.toContain(value);
  }
}

describe("the bundle", () => {
  it("strips types, renames .ts imports, and loads as a module whose default has scheduled", async () => {
    const modules = bundle(join(ROOT, "ops", "watcher", "src"));
    expect(modules[0]?.name).toBe("index.js");
    expect(modules.map((m) => m.name)).toContain("checks/tunnels.js");
    for (const m of modules) {
      expect(m.content).not.toMatch(/from\s*["'][^"']+\.ts["']/);
      expect(m.content).not.toMatch(/\bimport\s+type\b/);
    }
    const out = join(tmp, "bundle");
    for (const m of modules) {
      mkdirSync(dirname(join(out, m.name)), { recursive: true });
      writeFileSync(join(out, m.name), m.content);
    }
    writeFileSync(join(out, "package.json"), '{"type":"module"}');
    const loaded = (await import(pathToFileURL(join(out, "index.js")).href)) as {
      default: { scheduled?: unknown; fetch?: unknown };
    };
    expect(typeof loaded.default.scheduled).toBe("function");
    expect(loaded.default.fetch).toBeUndefined();
  });

  it("refuses a bare import and an import without its .ts file", () => {
    expect(() => rewriteImports("x.ts", 'import { a } from "node:fs";')).toThrow(BundleError);
    expect(() => rewriteImports("x.ts", 'import { a } from "./a";')).toThrow(BundleError);
    expect(rewriteImports("x.ts", 'export { a } from "../a.ts";')).toBe(
      'export { a } from "../a.js";',
    );
  });
});

describe("watcher deploy", () => {
  it("prints the plan in a dry run, checks the Worker's token, and changes nothing at Cloudflare", async () => {
    const apis = fakeApis();
    const { ctx, output } = await context(apis.fetch, ["--dry-run"]);
    const result = await watcherDeploy(ctx);
    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("dry run: nothing changed");
    expect(output.join("")).toContain(
      "the watcher's token: active, read-only (4 Read group(s)), expires in 90 days",
    );
    expect(cloudflareCalls(apis.calls).map((c) => c.method)).toEqual(["GET", "GET"]);
    expectNothingPrivate(output);
    expect(output.join("")).not.toContain(TOKEN_ID);
  });

  it("refuses the operator's own token as the Worker's, before any call", async () => {
    const apis = fakeApis();
    const { ctx } = await context(apis.fetch);
    const same = {
      ...environ,
      FIN_WATCHER_CF_TOKEN_FILE: environ.FIN_CLOUDFLARE_OPERATOR_TOKEN_FILE,
    };
    await expect(watcherDeploy({ ...ctx, environ: same })).rejects.toThrow(
      /FIN_WATCHER_CF_TOKEN_FILE holds the operator token/,
    );
    expect(apis.calls).toEqual([]);
  });

  it("refuses a Worker token that is not read-only, inactive, unexpiring or long-lived, and uploads nothing", async () => {
    const cases: [FakeOptions, RegExp][] = [
      [
        { groups: ["Zone Read", "Workers Scripts Write"] },
        /not read-only \(Workers Scripts Write\)/,
      ],
      [{ groups: ["DNS Edit"] }, /not read-only \(DNS Edit\)/],
      [{ status: "disabled" }, /not active/],
      [{ expiresOn: null }, /no expiry/],
      [{ expiresOn: inDays(400) }, /expires in 400 days, beyond its yearly rotation/],
      [{ expiresOn: inDays(-1) }, /has expired/],
      [{ groups: [] }, /grants no permission/],
    ];
    for (const [options, message] of cases) {
      const apis = fakeApis(options);
      const { ctx, output } = await context(apis.fetch);
      await expect(watcherDeploy(ctx), String(message)).rejects.toThrow(message);
      expect(cloudflareCalls(apis.calls).filter((c) => c.method !== "GET")).toEqual([]);
      expect(apis.calls.some((c) => new URL(c.url).hostname.endsWith("betterstack.com"))).toBe(
        false,
      );
      expectNothingPrivate(output);
    }
  });

  it("refuses a Worker token of another account, and says the operator token needs to read it", async () => {
    const stranger = file("stranger", ["stranger", "token"].join("-"));
    const apis = fakeApis();
    const { ctx } = await context(apis.fetch);
    await expect(
      watcherDeploy({ ...ctx, environ: { ...environ, FIN_WATCHER_CF_TOKEN_FILE: stranger } }),
    ).rejects.toThrow(/not a token of this account/);
  });

  it("reports a Cloudflare call that got no answer as such, never as a refused token", async () => {
    for (const [failure, said] of [
      [new TypeError("fetch failed"), "got no answer"],
      [new DOMException("The operation was aborted due to timeout", "TimeoutError"), "timed out"],
    ] as const) {
      for (const endpoint of ["/tokens/verify", `/tokens/${TOKEN_ID}`]) {
        const apis = fakeApis();
        const fetch = async (input: string, init?: RequestInit) => {
          if (new URL(input).pathname.endsWith(endpoint)) throw failure;
          return apis.fetch(input, init);
        };
        const { ctx } = await context(fetch);
        const run = watcherDeploy(ctx);
        await expect(run).rejects.toThrow(NoAnswerError);
        await expect(run).rejects.toThrow(
          new RegExp(`^GET /accounts/<account>/tokens/(verify|<token>) ${said}$`),
        );
      }
    }
  });

  it("refuses a Better Stack name that two sources share", async () => {
    const { ctx } = await context(fakeApis({ duplicateSource: true }).fetch);
    await expect(watcherDeploy(ctx)).rejects.toThrow(
      /Better Stack holds 2 sources named fin-next-staging-watcher/,
    );
  });

  it("notes what the watcher will report as unset", async () => {
    const apis = fakeApis();
    const { ctx, output } = await context(apis.fetch, ["--dry-run"]);
    const { http_request_firewall_managed: _gone, ...hashes } = ctx.registered.rulesetHashes;
    await watcherDeploy({
      ...ctx,
      registered: { ...ctx.registered, rulesetHashes: hashes, staticVersions: {} },
    });
    const text = output.join("");
    expect(text).toContain(
      "note: no registered hash for rule set phase http_request_firewall_managed: the watcher reports hash_unset",
    );
    expect(text).toContain(
      "note: no registered version for fin-next-staging-docs-static: the watcher reports version_unset",
    );
  });

  it("uploads modules, settings and exactly four secrets, then the schedule, then reads back", async () => {
    const apis = fakeApis();
    const { ctx, output } = await context(apis.fetch);
    const result = await watcherDeploy(ctx);
    expect(result.exitCode).toBe(0);
    const writes = apis.calls.filter((c) => c.method !== "GET");
    expect(
      writes.map((c) => `${c.method} ${new URL(c.url).pathname.split("/scripts/")[1]}`),
    ).toEqual([
      "PUT fin-next-staging-watcher",
      "PUT fin-next-staging-watcher/schedules",
      "POST fin-next-staging-watcher/subdomain",
    ]);
    const form = writes[0]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text()) as {
      main_module: string;
      bindings: { type: string; name: string; text: string }[];
    };
    expect(metadata.main_module).toBe("index.js");
    expect(metadata.bindings.map((b) => `${b.type}:${b.name}`)).toEqual([
      "plain_text:FIN_WATCHER_SETTINGS",
      "secret_text:FIN_CF_TOKEN",
      "secret_text:FIN_TELEMETRY_HOST",
      "secret_text:FIN_TELEMETRY_TOKEN",
      "secret_text:FIN_HEARTBEAT_WATCHER_URL",
    ]);
    const secret = (name: string) => metadata.bindings.find((b) => b.name === name)?.text;
    expect(secret("FIN_CF_TOKEN")).toBe(SECRETS.read);
    expect(secret("FIN_CF_TOKEN")).not.toBe(SECRETS.operator);
    expect(secret("FIN_TELEMETRY_TOKEN")).toBe(SECRETS.source);
    expect(secret("FIN_HEARTBEAT_WATCHER_URL")).toBe(SECRETS.heartbeat);
    const uploaded = JSON.parse(secret("FIN_WATCHER_SETTINGS") ?? "{}");
    expect(uploaded.zone).toBe(ZONE);
    expect(uploaded.staticVersions).toEqual(ctx.registered.staticVersions);
    // The Worker's token was proven read-only before the upload, and every write used the operator's.
    const firstWrite = apis.calls.findIndex((c) => c.method !== "GET");
    const tokenReads = apis.calls.filter((c) => new URL(c.url).pathname.includes("/tokens/"));
    expect(tokenReads.map((c) => apis.calls.indexOf(c) < firstWrite)).toEqual([true, true]);
    for (const w of writes) expect(w.auth).toBe(`Bearer ${SECRETS.operator}`);
    expect((form.get("index.js") as File).type).toBe("application/javascript+module");
    expect(JSON.parse(String(writes[1]?.body))).toEqual([{ cron: "* * * * *" }]);
    expect(JSON.parse(String(writes[2]?.body))).toEqual({
      enabled: false,
      previews_enabled: false,
    });
    const cfWrite = apis.calls.find((c) => c.method === "PUT");
    expect(cfWrite).toBeDefined();
    expectNothingPrivate(output);
  });

  it("fails when the read-back finds a binding it did not upload", async () => {
    const apis = fakeApis({ extraBinding: true });
    const { ctx, output } = await context(apis.fetch);
    const result = await watcherDeploy(ctx);
    expect(result.exitCode).toBe(1);
    expect(output.join("")).toContain("read-back failed");
  });

  it("refuses Better Stack tokens of another team, and an unknown argument", async () => {
    const { ctx } = await context(fakeApis({ team: "fin-production" }).fetch);
    await expect(watcherDeploy(ctx)).rejects.toThrow(/not fin-staging's/);
    const { ctx: bad } = await context(fakeApis().fetch, ["--force"]);
    await expect(watcherDeploy(bad)).rejects.toThrow(DeployError);
  });

  it("refuses a missing token file without reading anything", async () => {
    const apis = fakeApis();
    const { ctx } = await context(apis.fetch);
    await expect(
      watcherDeploy({
        ...ctx,
        environ: { ...environ, FIN_WATCHER_CF_TOKEN_FILE: join(tmp, "absent") },
      }),
    ).rejects.toThrow(/FIN_WATCHER_CF_TOKEN_FILE does not name a readable file/);
    expect(apis.calls).toEqual([]);
  });
});
