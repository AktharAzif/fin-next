// The re-read of a static deployment (spec 01 §6.9 step 4, §7.4's invariant): no script module, no
// binding, assets present, `workers_dev` and preview URLs off, and the compatibility date of its
// static.json. The watcher checks the same every minute (`static-deployment-changed`).

import type { StaticClient } from "./cloudflare.ts";
import type { StaticConfig } from "./config.ts";

interface ScriptSummary {
  id: string;
  has_modules?: boolean;
  has_assets?: boolean;
  handlers?: string[];
  placement_mode?: string;
}

interface ScriptSettings {
  bindings?: unknown[];
  compatibility_date?: string;
  tail_consumers?: unknown[] | null;
  logpush?: boolean;
}

interface Subdomain {
  enabled?: boolean;
  previews_enabled?: boolean;
}

/** The differences between a deployment and the invariant; none for a good one. */
export async function verifyDeployment(
  client: StaticClient,
  accountId: string,
  name: string,
  config: StaticConfig,
): Promise<string[]> {
  const problems: string[] = [];
  const base = `/accounts/${accountId}/workers/scripts`;
  const scripts = await client.get<ScriptSummary[]>(base);
  const script = scripts.find((s) => s.id === name);
  if (script === undefined) return ["the deployment does not exist"];
  if (script.has_modules !== false) problems.push("it has a script module");
  if (script.has_assets !== true) problems.push("it has no assets");
  if ((script.handlers ?? []).length > 0)
    problems.push(`it has handlers (${(script.handlers ?? []).join(", ")})`);
  const settings = await client.get<ScriptSettings>(`${base}/${name}/settings`);
  if ((settings.bindings ?? []).length > 0) problems.push("it has bindings");
  if ((settings.tail_consumers ?? []).length > 0) problems.push("it has tail consumers");
  if (
    settings.compatibility_date !== undefined &&
    settings.compatibility_date !== config.compatibility_date
  ) {
    problems.push("its compatibility date differs from static.json");
  }
  const subdomain = await client.get<Subdomain>(`${base}/${name}/subdomain`);
  if (subdomain.enabled !== false) problems.push("workers.dev is on");
  if (subdomain.previews_enabled !== false) problems.push("preview URLs are on");
  return problems;
}
