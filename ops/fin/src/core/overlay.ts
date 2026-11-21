// The private overlay (spec 01 §9.2, [G-09], CR-21): a JSON file outside the repository, named by
// FIN_OVERLAY_FILE and read at run time. It holds the zone, the hosts by role, the account and
// project IDs, the allow-list and the never-touch list, the staff list and the DMARC records.
//
// loadOverlay() registers every private value with the masker before it returns, so nothing the
// overlay holds can be printed afterwards. The only values left unmasked are the ones the plan
// itself publishes: the allow-list's host labels (console, staff, onboard, ...), the DMARC record
// labels, the environment's name and the file's own comments. A never-touch label is masked in its
// host form (`<label>.<zone>`, printed `<never-touch>`): a bare label under a masked zone names
// nothing, and masking bare words such as `_dmarc` or `www` would hide the plan's own labels.

import { lstatSync, readFileSync } from "node:fs";
import type { Env } from "./credentials.ts";
import { ConfigError } from "./errors.ts";
import type { Masker } from "./mask.ts";

/** The host roles code may name (AGENTS.md §2, "Hosts by role"). */
export const HOST_ROLES = ["console", "admin", "verify", "selfie", "docs", "api", "pg"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

export interface Overlay {
  environment: string;
  zone: string;
  hosts: Readonly<Partial<Record<HostRole, string>>>;
  emailSubdomains: Readonly<Record<string, string>>;
  cloudflare: { accountId: string; zoneId: string };
  railway: { projectId: string; environmentId: string };
  access: { staff: readonly string[]; allowDomains: readonly string[] };
  email: { seedInbox?: string };
  allowedNames: {
    labels: readonly string[];
    spikeOnly: readonly string[];
    fallbackOnly: readonly string[];
  };
  neverTouch: { labels: readonly string[] };
  dmarc: { records: readonly string[]; policy?: string; rua?: string };
  /** Static egress addresses per Railway service, once read back (spec 01 §6.5). */
  staticEgress: Readonly<Record<string, readonly string[]>>;
  /** Numeric thresholds ([OB-13]), such as `api-v4` for the rate rule. */
  thresholds: Readonly<Record<string, number>>;
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LABEL =
  /^(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9])?)*$/;
const CF_ID = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EMAIL = /^[^\s@]+@([a-z0-9.-]+\.[a-z]{2,63})$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** Keys whose values the plan publishes, so they are not masked. Paths use dots and [i]. */
const PUBLIC_PATHS = [
  /^environment$/,
  /(^|\.)_comment$/,
  /(^|\.)note$/,
  /^allowedNames\.(labels|spikeOnly|fallbackOnly)\[\d+\]$/,
  /^dmarc\.(records\[\d+\]|policy)$/,
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every string leaf with its path, for masking. */
function leaves(value: Json, path: string, out: Array<[string, string]>): void {
  if (typeof value === "string") out.push([path, value]);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) leaves(item, `${path}[${i}]`, out);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      leaves(item as Json, path === "" ? key : `${path}.${key}`, out);
    }
  }
}

/** Registers every private value of the parsed file, the most specific placeholders first. */
export function registerOverlay(raw: unknown, masker: Masker): void {
  if (!isRecord(raw)) return;
  const zone = raw.zone;
  const hosts = raw.hosts;
  if (isRecord(hosts)) {
    for (const [role, host] of Object.entries(hosts)) {
      if (typeof host === "string") masker.register(host, `<host:${role}>`);
    }
  }
  const subdomains = raw.emailSubdomains;
  if (isRecord(subdomains)) {
    for (const [name, host] of Object.entries(subdomains)) {
      if (typeof host === "string") masker.register(host, `<email:${name}>`);
    }
  }
  if (typeof zone === "string") masker.register(zone, "<zone>");
  const found: Array<[string, string]> = [];
  leaves(raw as Json, "", found);
  for (const [path, value] of found) {
    if (PUBLIC_PATHS.some((p) => p.test(path))) continue;
    if (/^neverTouch\.labels\[\d+\]$/.test(path)) {
      if (typeof zone === "string" && value !== "@")
        masker.register(`${value}.${zone}`, "<never-touch>");
      continue;
    }
    masker.register(value, `<overlay:${path}>`);
  }
}

function strings(value: unknown, path: string, problems: string[], pattern?: RegExp): string[] {
  if (!Array.isArray(value)) {
    problems.push(`${path} must be an array of strings`);
    return [];
  }
  const out: string[] = [];
  value.forEach((item, i) => {
    if (typeof item !== "string" || item === "") problems.push(`${path}[${i}] must be a string`);
    else if (pattern !== undefined && !pattern.test(item)) {
      problems.push(`${path}[${i}] has the wrong shape`);
    } else out.push(item);
  });
  return out;
}

function str(value: unknown, path: string, problems: string[], pattern?: RegExp): string {
  if (typeof value !== "string" || value === "") {
    problems.push(`${path} must be a non-empty string`);
    return "";
  }
  if (pattern !== undefined && !pattern.test(value)) problems.push(`${path} has the wrong shape`);
  return value;
}

function rec(value: unknown, path: string, problems: string[]): Record<string, unknown> {
  if (!isRecord(value)) {
    problems.push(`${path} must be an object`);
    return {};
  }
  return value;
}

/**
 * Validates a parsed overlay for an environment. Problems name the key, never the value. Besides
 * the shapes, it checks that the file is consistent with itself: every host sits one label below
 * the zone, every host label is on the allow-list, and no allowed label is also never-touch.
 */
export function parseOverlay(raw: unknown, environment: string): Overlay {
  const problems: string[] = [];
  const top = rec(raw, "the overlay", problems);
  const env = str(top.environment, "environment", problems);
  if (env !== "" && env !== environment) {
    problems.push(`environment is "${env}", but this run is for "${environment}"`);
  }
  const zone = str(top.zone, "zone", problems, DOMAIN);

  const hostsRaw = rec(top.hosts, "hosts", problems);
  const hosts: Partial<Record<HostRole, string>> = {};
  for (const [role, value] of Object.entries(hostsRaw)) {
    if (!(HOST_ROLES as readonly string[]).includes(role)) {
      problems.push(`hosts.${role} is not a known host role`);
      continue;
    }
    hosts[role as HostRole] = str(value, `hosts.${role}`, problems, DOMAIN);
  }
  const subdomainsRaw = top.emailSubdomains === undefined ? {} : top.emailSubdomains;
  const emailSubdomains: Record<string, string> = {};
  for (const [name, value] of Object.entries(rec(subdomainsRaw, "emailSubdomains", problems))) {
    emailSubdomains[name] = str(value, `emailSubdomains.${name}`, problems, DOMAIN);
  }

  const cf = rec(top.cloudflare, "cloudflare", problems);
  const railway = rec(top.railway, "railway", problems);
  const access = rec(top.access, "access", problems);
  const email = top.email === undefined ? {} : rec(top.email, "email", problems);
  const allowed = rec(top.allowedNames, "allowedNames", problems);
  const never = rec(top.neverTouch, "neverTouch", problems);
  const dmarc = top.dmarc === undefined ? {} : rec(top.dmarc, "dmarc", problems);

  const staticEgress: Record<string, string[]> = {};
  if (top.staticEgress !== undefined) {
    for (const [service, value] of Object.entries(
      rec(top.staticEgress, "staticEgress", problems),
    )) {
      staticEgress[service] = strings(value, `staticEgress.${service}`, problems).filter((ip) => {
        if (IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip))) return true;
        problems.push(`staticEgress.${service} holds a value that is not an IP address`);
        return false;
      });
    }
  }
  const thresholds: Record<string, number> = {};
  if (top.thresholds !== undefined) {
    for (const [name, value] of Object.entries(rec(top.thresholds, "thresholds", problems))) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        problems.push(`thresholds.${name} must be a positive integer`);
      } else thresholds[name] = value;
    }
  }

  const overlay: Overlay = {
    environment: env,
    zone,
    hosts,
    emailSubdomains,
    cloudflare: {
      accountId: str(cf.accountId, "cloudflare.accountId", problems, CF_ID),
      zoneId: str(cf.zoneId, "cloudflare.zoneId", problems, CF_ID),
    },
    railway: {
      projectId: str(railway.projectId, "railway.projectId", problems, UUID),
      environmentId: str(railway.environmentId, "railway.environmentId", problems, UUID),
    },
    access: {
      staff: strings(access.staff, "access.staff", problems, EMAIL),
      allowDomains: strings(access.allowDomains, "access.allowDomains", problems, DOMAIN),
    },
    email:
      email.seedInbox === undefined
        ? {}
        : { seedInbox: str(email.seedInbox, "email.seedInbox", problems, EMAIL) },
    allowedNames: {
      labels: strings(allowed.labels, "allowedNames.labels", problems, LABEL),
      spikeOnly: strings(allowed.spikeOnly ?? [], "allowedNames.spikeOnly", problems, LABEL),
      fallbackOnly: strings(
        allowed.fallbackOnly ?? [],
        "allowedNames.fallbackOnly",
        problems,
        LABEL,
      ),
    },
    neverTouch: { labels: strings(never.labels, "neverTouch.labels", problems) },
    dmarc: {
      records: strings(dmarc.records ?? [], "dmarc.records", problems, LABEL),
      ...(typeof dmarc.policy === "string" ? { policy: dmarc.policy } : {}),
      ...(dmarc.rua === undefined
        ? {}
        : {
            rua: str(dmarc.rua, "dmarc.rua", problems, /^mailto:[^\s;,]+(,mailto:[^\s;,]+)*$/),
          }),
    },
    staticEgress,
    thresholds,
  };

  // Consistency: the overlay must agree with itself before any guard trusts it.
  if (zone !== "" && problems.length === 0) {
    const never = new Set(overlay.neverTouch.labels.map((l) => l.toLowerCase()));
    const allLabels = [
      ...overlay.allowedNames.labels,
      ...overlay.allowedNames.spikeOnly,
      ...overlay.allowedNames.fallbackOnly,
    ];
    for (const label of allLabels) {
      if (never.has(label.toLowerCase())) {
        problems.push("allowedNames and neverTouch share a label; the overlay must not do that");
        break;
      }
    }
    for (const [role, host] of Object.entries(hosts)) {
      const suffix = `.${zone}`;
      if (host === undefined || !host.endsWith(suffix)) {
        problems.push(`hosts.${role} is not under the zone`);
        continue;
      }
      const label = host.slice(0, -suffix.length);
      if (label.includes(".")) problems.push(`hosts.${role} is not one label below the zone`);
      else if (!overlay.allowedNames.labels.includes(label)) {
        problems.push(`hosts.${role} has a label that allowedNames.labels does not list`);
      }
    }
    for (const [name, host] of Object.entries(emailSubdomains)) {
      if (!host.endsWith(`.${zone}`))
        problems.push(`emailSubdomains.${name} is not under the zone`);
    }
  }
  if (problems.length > 0) {
    throw new ConfigError(`the overlay is invalid: ${problems.join("; ")}`);
  }
  return overlay;
}

/**
 * Loads the overlay that FIN_OVERLAY_FILE names, registers every private value with the masker,
 * and validates it for the environment.
 */
export function loadOverlay(env: Env, environment: string, masker: Masker): Overlay {
  const path = env.FIN_OVERLAY_FILE;
  if (path === undefined || path === "") {
    throw new ConfigError("FIN_OVERLAY_FILE is not set: it names the private overlay file");
  }
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    throw new ConfigError("FIN_OVERLAY_FILE names a file that does not exist");
  }
  if (!stat.isFile()) throw new ConfigError("FIN_OVERLAY_FILE must name a regular file");
  if ((stat.mode & 0o077) !== 0) {
    throw new ConfigError("FIN_OVERLAY_FILE names a file that others can read (chmod 600)");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError("FIN_OVERLAY_FILE is not valid JSON");
  }
  registerOverlay(raw, masker);
  return parseOverlay(raw, environment);
}

/** The hostname of a role, or a ConfigError naming the role the overlay lacks. */
export function hostOf(overlay: Overlay, role: HostRole): string {
  const host = overlay.hosts[role];
  if (host === undefined || host === "") {
    throw new ConfigError(`the overlay has no hosts.${role}`);
  }
  return host;
}
