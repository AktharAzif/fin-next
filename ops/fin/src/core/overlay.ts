// The private overlay (spec 01 §9.2, [G-09], CR-21): a JSON file outside the repository, named by
// FIN_OVERLAY_FILE and read at run time. It holds the zone, the hosts by role, the account and
// project IDs, the allow-list and the never-touch list, the staff list, the DMARC records, and the
// private numbers (alert thresholds, grace periods, the roster's timings, [OB-13]).
//
// registerOverlay() registers every private value with the masker before validation, so nothing
// the overlay holds can be printed afterwards, not even by a refusal. Every value counts, numbers
// included. The only values left unmasked are the ones the plan itself publishes: the allow-list's
// host labels (console, staff, onboard, ...), the DMARC record labels, policy and note, the
// environment's name and the comments at the places this file defines them (PUBLIC_PATHS). A
// never-touch label is masked in its host form (`<label>.<zone>`, printed `<never-touch>`): a bare
// label under a masked zone names nothing, and masking bare words such as `_dmarc` or `www` would
// hide the plan's own labels.
//
// Keys are private too when they are not plain names: a key that holds a dot, an `@`, a space or a
// private value (a map written the wrong way round, a host as a key) is registered like a value and
// never shown in a placeholder or a message.

import { lstatSync, readFileSync } from "node:fs";
import type { Env } from "./credentials.ts";
import { ConfigError } from "./errors.ts";
import { Masker } from "./mask.ts";

/** The host roles code may name (AGENTS.md §2, "Hosts by role"). */
export const HOST_ROLES = ["console", "admin", "verify", "selfie", "docs", "api", "pg"] as const;
export type HostRole = (typeof HOST_ROLES)[number];

export const DMARC_POLICIES = ["none", "quarantine", "reject"] as const;
export type DmarcPolicy = (typeof DMARC_POLICIES)[number];

export interface Overlay {
  environment: string;
  zone: string;
  hosts: Readonly<Partial<Record<HostRole, string>>>;
  emailSubdomains: Readonly<Record<string, string>>;
  /**
   * The account Fin's objects live in. `zoneId`, when the file holds one, is only what the zone's
   * ID is expected to be: Guard.bindZone() checks the zone Cloudflare names against the overlay's
   * zone and account, and every zone write uses the guard's checked ID, never this one.
   */
  cloudflare: { accountId: string; zoneId?: string };
  railway: { projectId: string; environmentId: string };
  /**
   * Who passes Access on the admin host: the exact staff addresses (spec 01 §7.7), and, by the
   * owner's staging decision of 21 Nov, the company's email domains with a one-time PIN. Either
   * list may be empty or absent.
   */
  access: { staff: readonly string[]; allowDomains: readonly string[] };
  email: { seedInbox?: string };
  allowedNames: {
    labels: readonly string[];
    spikeOnly: readonly string[];
    fallbackOnly: readonly string[];
  };
  /**
   * Never-touch names as labels under the zone, normalised (lower case, no trailing dot, no zone
   * suffix); `@` is the apex. Every name on or under one of them is refused.
   */
  neverTouch: { labels: readonly string[] };
  dmarc: { records: readonly string[]; policy?: DmarcPolicy; rua?: string };
  /** Static egress addresses per Railway service, once read back (spec 01 §6.5). */
  staticEgress: Readonly<Record<string, readonly string[]>>;
  /** Numeric thresholds ([OB-13]), such as `api-v4` for the rate rule. Read with thresholdOf(). */
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
const DMARC_POLICY = /^(?:p=)?(none|quarantine|reject)$/;
/** A key a map uses for a name: a sending subdomain, a service, an alert or a heartbeat. */
const NAME_KEY = /^[a-z][a-z0-9-]{0,62}$/;
/** A key that may appear in a placeholder: a plain identifier, never a host, an address or text. */
const PRINTABLE_KEY = /^[$_]?[A-Za-z][A-Za-z0-9_-]{0,62}$/;

/**
 * The values the plan publishes, so they are not masked: exact paths only (dots and [i]). A
 * comment or a note anywhere else is masked like any other value; over-masking costs nothing.
 */
const PUBLIC_PATHS = [
  /^environment$/,
  /^[$_]comment$/,
  /^(?:allowedNames|neverTouch|dmarc)\.[$_]comment$/,
  /^allowedNames\.(?:labels|spikeOnly|fallbackOnly)\[\d+\]$/,
  /^dmarc\.(?:records\[\d+\]|policy|note)$/,
];
const NEVER_TOUCH_PATH = /^neverTouch\.labels\[\d+\]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHostRole(value: string): value is HostRole {
  return (HOST_ROLES as readonly string[]).includes(value);
}

type Segment = string | number;

interface Leaf {
  segments: readonly Segment[];
  value: string | number;
}

function pathOf(segments: readonly Segment[], show: (key: string) => string): string {
  return segments
    .map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? show(s) : `.${show(s)}`))
    .join("");
}

/** Every string and number leaf with its path, and every key on the way. */
function walk(value: unknown, segments: Segment[], leaves: Leaf[], keys: Set<string>): void {
  if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
    leaves.push({ segments, value });
  } else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, [...segments, i], leaves, keys);
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      keys.add(key);
      walk(item, [...segments, key], leaves, keys);
    }
  }
}

/**
 * A never-touch entry as a label under the zone: trimmed, lower case, without one trailing dot or
 * the zone's suffix. `@` (or the zone itself) is the apex. Undefined when it is not a label.
 */
export function neverTouchLabel(entry: string, zone: string): string | undefined {
  let name = entry.trim().toLowerCase();
  if (name.endsWith(".")) name = name.slice(0, -1);
  const apex = zone.trim().toLowerCase().replace(/\.$/, "");
  if (name === "@" || (apex !== "" && name === apex)) return "@";
  if (apex !== "" && name.endsWith(`.${apex}`)) name = name.slice(0, -(apex.length + 1));
  return LABEL.test(name) ? name : undefined;
}

/** Whether a label is a never-touch label or sits under one (the apex `@` covers only itself). */
export function underNeverTouch(label: string, never: readonly string[]): boolean {
  return never.some((n) => n !== "@" && (label === n || label.endsWith(`.${n}`)));
}

/** Registers every private value of the parsed file (and every key that is not a plain name). */
export function registerOverlay(raw: unknown, masker: Masker): void {
  if (!isRecord(raw)) return;
  const leaves: Leaf[] = [];
  const keys = new Set<string>();
  walk(raw, [], leaves, keys);
  const realPath = (leaf: Leaf) => pathOf(leaf.segments, (k) => k);
  const isPublic = (leaf: Leaf) => {
    const path = realPath(leaf);
    return PUBLIC_PATHS.some((p) => p.test(path));
  };

  // A key may be shown only when it is a plain name that holds no private value (a bare
  // never-touch label is not one: see the header).
  const privateText = new Masker();
  for (const leaf of leaves) {
    if (!isPublic(leaf) && !NEVER_TOUCH_PATH.test(realPath(leaf))) {
      privateText.register(leaf.value, "<x>");
    }
  }
  const printable = (key: string) => PRINTABLE_KEY.test(key) && !privateText.leaks(key);
  const shown = (leaf: Leaf) => pathOf(leaf.segments, (k) => (printable(k) ? k : "*"));

  // The most specific placeholders first: hosts by role, the sending subdomains, then the zone.
  if (isRecord(raw.hosts)) {
    for (const [role, host] of Object.entries(raw.hosts)) {
      if (typeof host === "string")
        masker.register(host, isHostRole(role) ? `<host:${role}>` : "<host>");
    }
  }
  if (isRecord(raw.emailSubdomains)) {
    for (const [name, host] of Object.entries(raw.emailSubdomains)) {
      const placeholder = NAME_KEY.test(name) && printable(name) ? `<email:${name}>` : "<email>";
      if (typeof host === "string") masker.register(host, placeholder);
    }
  }
  const zone = typeof raw.zone === "string" ? raw.zone : "";
  if (zone !== "") masker.register(zone, "<zone>");
  for (const leaf of leaves) {
    if (isPublic(leaf)) continue;
    if (NEVER_TOUCH_PATH.test(realPath(leaf)) && typeof leaf.value === "string") {
      const label = neverTouchLabel(leaf.value, zone);
      if (label === undefined) masker.register(leaf.value, "<never-touch>");
      else if (label !== "@" && zone !== "") masker.register(`${label}.${zone}`, "<never-touch>");
      continue;
    }
    masker.register(leaf.value, `<overlay:${shown(leaf)}>`);
  }
  for (const key of keys) if (!printable(key)) masker.register(key, "<overlay-key>");
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
 * The entries of a map whose keys are names (a sending subdomain, a service, an alert). A key that
 * is not a plain name is reported without being echoed, and left out.
 */
function named(
  value: Record<string, unknown>,
  path: string,
  what: string,
  problems: string[],
): Array<[string, unknown]> {
  const entries = Object.entries(value);
  const good = entries.filter(([key]) => NAME_KEY.test(key));
  if (good.length < entries.length) problems.push(`${path} holds a key that is not ${what}`);
  return good;
}

/**
 * Validates a parsed overlay for an environment. Problems name the key, never the value, and name
 * a map's key only when it is a plain name. Besides the shapes, it checks that the file is
 * consistent with itself: every host sits one label below the zone, every host label is on the
 * allow-list, and no allowed name is, or sits under, a never-touch label.
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
  let unknownRole = false;
  for (const [role, value] of Object.entries(hostsRaw)) {
    if (!isHostRole(role)) unknownRole = true;
    else hosts[role] = str(value, `hosts.${role}`, problems, DOMAIN);
  }
  if (unknownRole)
    problems.push(`hosts holds a key that is not a host role (${HOST_ROLES.join(", ")})`);

  const emailSubdomains: Record<string, string> = {};
  const subdomainsRaw = top.emailSubdomains === undefined ? {} : top.emailSubdomains;
  const subdomainEntries = named(
    rec(subdomainsRaw, "emailSubdomains", problems),
    "emailSubdomains",
    "a sending subdomain's name",
    problems,
  );
  for (const [name, value] of subdomainEntries) {
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
    const entries = named(
      rec(top.staticEgress, "staticEgress", problems),
      "staticEgress",
      "a service's name",
      problems,
    );
    for (const [service, value] of entries) {
      staticEgress[service] = strings(value, `staticEgress.${service}`, problems).filter((ip) => {
        if (IPV4.test(ip) || (ip.includes(":") && IPV6.test(ip))) return true;
        problems.push(`staticEgress.${service} holds a value that is not an IP address`);
        return false;
      });
    }
  }
  const thresholds: Record<string, number> = {};
  if (top.thresholds !== undefined) {
    const entries = named(
      rec(top.thresholds, "thresholds", problems),
      "thresholds",
      "an alert's name",
      problems,
    );
    for (const [name, value] of entries) {
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        problems.push(`thresholds.${name} must be a positive integer`);
      } else thresholds[name] = value;
    }
  }

  const neverTouch: string[] = [];
  if (!Array.isArray(never.labels)) problems.push("neverTouch.labels must be an array of strings");
  else {
    never.labels.forEach((entry: unknown, i: number) => {
      const label = typeof entry === "string" ? neverTouchLabel(entry, zone) : undefined;
      if (label === undefined)
        problems.push(`neverTouch.labels[${i}] is not a label under the zone, or @`);
      else if (!neverTouch.includes(label)) neverTouch.push(label);
    });
  }

  let policy: DmarcPolicy | undefined;
  if (dmarc.policy !== undefined) {
    const match = typeof dmarc.policy === "string" ? DMARC_POLICY.exec(dmarc.policy) : null;
    if (match === null) problems.push(`dmarc.policy must be one of ${DMARC_POLICIES.join(", ")}`);
    else policy = match[1] as DmarcPolicy;
  }

  const overlay: Overlay = {
    environment: env,
    zone,
    hosts,
    emailSubdomains,
    cloudflare: {
      accountId: str(cf.accountId, "cloudflare.accountId", problems, CF_ID),
      ...(cf.zoneId === undefined
        ? {}
        : { zoneId: str(cf.zoneId, "cloudflare.zoneId", problems, CF_ID) }),
    },
    railway: {
      projectId: str(railway.projectId, "railway.projectId", problems, UUID),
      environmentId: str(railway.environmentId, "railway.environmentId", problems, UUID),
    },
    access: {
      staff: strings(access.staff ?? [], "access.staff", problems, EMAIL),
      allowDomains: strings(access.allowDomains ?? [], "access.allowDomains", problems, DOMAIN),
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
    neverTouch: { labels: neverTouch },
    dmarc: {
      records: strings(dmarc.records ?? [], "dmarc.records", problems, LABEL),
      ...(policy === undefined ? {} : { policy }),
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
    const allLabels = [
      ...overlay.allowedNames.labels,
      ...overlay.allowedNames.spikeOnly,
      ...overlay.allowedNames.fallbackOnly,
    ];
    if (allLabels.some((label) => underNeverTouch(label, neverTouch))) {
      problems.push(
        "allowedNames and neverTouch share a label (an allowed name is, or sits under, a never-touch label); the overlay must not do that",
      );
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

/** Reads the overlay file FIN_OVERLAY_FILE names: an owner-only regular file holding JSON. */
function readOverlayFile(path: string): unknown {
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
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new ConfigError("FIN_OVERLAY_FILE is not valid JSON");
  }
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
  const raw = readOverlayFile(path);
  registerOverlay(raw, masker);
  return parseOverlay(raw, environment);
}

/**
 * For a command that does not need the overlay: when FIN_OVERLAY_FILE is set, registers its values
 * with the masker anyway (without validating it), so whatever the command prints or logs is
 * masked. Returns whether the values were registered, or why not.
 */
export function registerOverlayFile(
  env: Env,
  masker: Masker,
): { registered: true } | { registered: false; reason: string } {
  const path = env.FIN_OVERLAY_FILE;
  if (path === undefined || path === "") {
    return { registered: false, reason: "FIN_OVERLAY_FILE is not set" };
  }
  try {
    registerOverlay(readOverlayFile(path), masker);
    return { registered: true };
  } catch (error) {
    return {
      registered: false,
      reason: error instanceof ConfigError ? error.message : "the overlay could not be read",
    };
  }
}

/** The hostname of a role, or a ConfigError naming the role the overlay lacks. */
export function hostOf(overlay: Overlay, role: HostRole): string {
  const host = Object.hasOwn(overlay.hosts, role) ? overlay.hosts[role] : undefined;
  if (host === undefined || host === "") {
    throw new ConfigError(`the overlay has no hosts.${role}`);
  }
  return host;
}

/** A threshold by its (public) name, or a ConfigError naming the threshold the overlay lacks. */
export function thresholdOf(overlay: Overlay, name: string): number {
  const value = Object.hasOwn(overlay.thresholds, name) ? overlay.thresholds[name] : undefined;
  if (value === undefined) throw new ConfigError(`the overlay has no thresholds.${name}`);
  return value;
}
