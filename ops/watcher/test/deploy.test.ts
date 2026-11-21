import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { BundleError, bundle, rewriteImports } from "../deploy/bundle.ts";
import { DeployError, type WatcherDeployContext, watcherDeploy } from "../deploy/deploy.ts";
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
}

function fakeApis(options: { team?: string; extraBinding?: boolean } = {}) {
  const calls: Call[] = [];
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    calls.push({ method: init?.method ?? "GET", url: input, body: init?.body });
    const team = options.team ?? "fin-staging";
    if (url.hostname === "telemetry.betterstack.com") {
      return json({
        data: [
          {
            id: "1",
            type: "source",
            attributes: {
              name: "fin-next-staging-watcher",
              team_name: team,
              token: SECRETS.source,
              ingesting_host: SECRETS.host,
            },
          },
        ],
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
    },
    release: "e".repeat(40),
    environ,
    stdout: { write: (t) => output.push(t) },
    ...(fetch === undefined ? {} : { fetch }),
  };
  return { ctx, output };
}

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
  it("prints the plan in a dry run and changes nothing at Cloudflare", async () => {
    const apis = fakeApis();
    const { ctx, output } = await context(apis.fetch, ["--dry-run"]);
    const result = await watcherDeploy(ctx);
    expect(result.exitCode).toBe(0);
    expect(output.join("")).toContain("dry run: nothing changed");
    expect(apis.calls.filter((c) => new URL(c.url).hostname === "api.cloudflare.com")).toEqual([]);
    expectNothingPrivate(output);
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
    expect(secret("FIN_TELEMETRY_TOKEN")).toBe(SECRETS.source);
    expect(secret("FIN_HEARTBEAT_WATCHER_URL")).toBe(SECRETS.heartbeat);
    expect(JSON.parse(secret("FIN_WATCHER_SETTINGS") ?? "{}").zone).toBe(ZONE);
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
