// An app's `static.json` (spec 01 §7.4, a control path): only the allowlisted keys, with the only
// allowed values, so a deployment can never gain a script, a binding, `run_worker_first`, a route,
// a cron or a custom domain from configuration. The same rule scripts/static-check.mjs enforces at
// CI time is enforced again here, at the moment of upload.

import { readFileSync } from "node:fs";

export class StaticConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticConfigError";
  }
}

export interface StaticConfig {
  compatibility_date: string;
  assets: { not_found_handling: "single-page-application"; html_handling: "auto-trailing-slash" };
  workers_dev: false;
  preview_urls: false;
}

const TOP = new Set(["compatibility_date", "assets", "workers_dev", "preview_urls"]);
const ASSETS = new Set(["not_found_handling", "html_handling"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a parsed static.json. Every problem is named; any one refuses the upload. */
export function parseStaticConfig(raw: unknown, file = "static.json"): StaticConfig {
  const problems: string[] = [];
  if (!isRecord(raw)) throw new StaticConfigError(`${file} must be a JSON object`);
  for (const key of Object.keys(raw)) {
    if (!TOP.has(key))
      problems.push(
        `the key ${key} is not allowed (no main, module, binding, run_worker_first, route, cron or domain)`,
      );
  }
  if (
    typeof raw.compatibility_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(raw.compatibility_date)
  ) {
    problems.push("compatibility_date must be YYYY-MM-DD");
  }
  if (raw.workers_dev !== false) problems.push("workers_dev must be false");
  if (raw.preview_urls !== false) problems.push("preview_urls must be false");
  const assets = raw.assets;
  if (!isRecord(assets)) problems.push("assets must be an object");
  else {
    for (const key of Object.keys(assets)) {
      if (!ASSETS.has(key))
        problems.push(`assets.${key} is not allowed (no directory, binding or run_worker_first)`);
    }
    if (assets.not_found_handling !== "single-page-application") {
      problems.push("assets.not_found_handling must be single-page-application");
    }
    if (assets.html_handling !== "auto-trailing-slash")
      problems.push("assets.html_handling must be auto-trailing-slash");
  }
  if (problems.length > 0) throw new StaticConfigError(`${file}: ${problems.join("; ")}`);
  return raw as unknown as StaticConfig;
}

export function loadStaticConfig(file: string): StaticConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new StaticConfigError(`${file} is missing or not valid JSON`);
  }
  return parseStaticConfig(raw, file);
}

/** The deployment names Fin uploads: `fin-next-<env>-<app>-static` and nothing else. */
export const DEPLOYMENT_NAME = /^fin-next-(staging|production)-[a-z]+-static$/;

export function checkDeploymentName(name: string): void {
  if (!DEPLOYMENT_NAME.test(name)) {
    throw new StaticConfigError(
      `${name} is not a static deployment name (fin-next-<env>-<app>-static)`,
    );
  }
}
